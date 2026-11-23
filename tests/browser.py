"""Runs the browser test suite: the real app, served from a sandbox, in an isolated headless Edge or Chrome.

    python tests/browser.py                  synthetic games
    python tests/browser.py --real           also compare your local replays with their saved baseline
    python tests/browser.py --update-golden  record new baselines (only after reviewing why they changed)

Local replay baselines are kept in tests/.local/ (git-ignored) because they contain real match data.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path

REAL_POPEN = subprocess.Popen
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tests import fixtures as fx  # noqa: E402
from tests.sandbox import ROOT, Sandbox, core  # noqa: E402

import server as s  # noqa: E402

JS = ROOT / "tests" / "js"
GOLDEN = ROOT / "tests" / "golden" / "synthetic.json"
LOCAL_GOLDEN = ROOT / "tests" / ".local" / "real_golden.json"
SUITES = ["harness.js", "test_model.js", "test_review.js", "test_app.js", "test_views.js", "test_flows.js"]
TIMEOUT = 420


def scenarios():
    games = {f"riot-{p}": fx.make_game(p, 1) for p in fx.PATCHES}
    games["red-win"] = fx.make_game("16.23", 2, winner=200, match_id="NA1_5000000102")
    games["short"] = fx.make_game("16.23", 3, minutes=16, match_id="NA1_5000000103")
    games["long"] = fx.make_game("16.22", 4, minutes=46, match_id="NA1_5000000104")
    games["aram"] = fx.make_game("16.23", 5, map_id=12, queue=450, mode="ARAM", match_id="NA1_5000000105")
    wire, tl = fx.to_lcu_wire(fx.make_game("16.21", 6, match_id="NA1_5000000106"))
    return games, wire, tl


def build_lcu_game(wire, tl):
    core._champ_table = fx.CHAMPION_TABLE
    real = core.lcu_get
    core.lcu_get = lambda path, timeout=30: tl if "game-timelines" in path else wire
    try:
        return core.lcu_match("NA1_5000000106")
    finally:
        core.lcu_get = real


class Results:
    def __init__(self):
        self.done = threading.Event()
        self.data = None


def make_handler(games, results, opts):
    class H(s.Handler):
        def _send(self, body, ctype="application/json"):
            if isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path == "/__e2e":
                html = (core.STATIC / "index.html").read_text("utf-8")
                tags = "".join(f'<script src="/__t/js/{f}"></script>' for f in SUITES)
                return self._send(html.replace('<base href="/">', "").replace("<head>", '<head><base href="/">', 1).replace("</body>", tags + "</body>"), "text/html; charset=utf-8")
            if u.path.startswith("/__t/js/"):
                return self._send((JS / Path(u.path).name).read_bytes(), "text/javascript; charset=utf-8")
            if u.path == "/__t/game":
                return self._send(json.dumps(games[q["id"][0]]))
            if u.path == "/__t/config":
                golden = json.loads(GOLDEN.read_text("utf-8")) if GOLDEN.exists() else {}
                local = json.loads(LOCAL_GOLDEN.read_text("utf-8")) if opts["real"] and LOCAL_GOLDEN.exists() else {}
                real_ids = sorted(p.stem for p in (ROOT / "cache").glob("*_*.json")) if opts["real"] else []
                return self._send(json.dumps({"games": sorted(games), "golden": golden, "local": local, "realIds": real_ids, "update": opts["update"]}))
            if u.path == "/__t/real":
                mid = q["id"][0]
                f = ROOT / "cache" / f"{mid}.json"
                return self._send(f.read_bytes() if opts["real"] and f.is_file() and f.parent == ROOT / "cache" else b"{}")
            return super().do_GET()

        def do_POST(self):
            if urllib.parse.urlparse(self.path).path == "/__t/results":
                n = int(self.headers.get("Content-Length") or 0)
                results.data = json.loads(self.rfile.read(n))
                self._send("{}")
                results.done.set()
                return None
            return super().do_POST()
    return H


def _run_quietly(args, timeout):
    """subprocess.run is blocked inside the sandbox, so helper processes use the saved Popen directly."""
    try:
        REAL_POPEN(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).wait(timeout)
    except (OSError, subprocess.SubprocessError):
        pass


def stop_browser(profile, proc):
    """Stops only the browser started for this run, identified by its temporary profile folder."""
    _run_quietly(["taskkill", "/T", "/F", "/PID", str(proc.pid)], 10)
    needle = str(profile).replace("'", "''")
    ps = f"Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | Where-Object {{ $_.CommandLine -like '*{needle}*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
    _run_quietly(["powershell", "-NoProfile", "-Command", ps], 30)


def run(real=False, update=False, quiet=False):
    browser = s.find_app_browser()
    if not browser:
        print("Edge or Chrome is required for the browser tests.")
        return None
    box = Sandbox().start()
    profile = Path(tempfile.mkdtemp(prefix="lra_edge_"))
    srv = proc = None
    saved_port = s.OPTS["port"]
    saved_recorder = s.RECORDER
    try:
        games, wire, tl = scenarios()
        games["lcu"] = build_lcu_game(wire, tl)
        core._champ_table = fx.CHAMPION_TABLE
        core._dd_version = "16.23.1"
        s.RECORDER = None
        for key, g in games.items():
            mid = g["match"]["metadata"]["matchId"]
            if key == "riot-15.12":
                mid = "NA1_5000000201"
            elif key == "riot-16.10":
                mid = "NA1_5000000202"
            elif key == "riot-16.23":
                mid = "NA1_5000000203"
            g["match"]["metadata"]["matchId"] = mid
            g["timeline"]["metadata"] = {"matchId": mid}
            (core.CACHE / f"{mid}.json").write_text(json.dumps(g), "utf-8")
            ver = g["match"]["info"]["gameVersion"].rsplit(".", 1)[0] + ".6595"
            plat, gid = mid.split("_")
            if key != "lcu":
                (core.DEFAULT_REPLAY_DIR / f"{plat}-{gid}.rofl").write_bytes(fx.make_rofl(g, version=ver))
        results = Results()
        srv = s.AppServer(("127.0.0.1", 0), make_handler(games, results, {"real": real, "update": update}))
        port = srv.server_address[1]
        s.OPTS["port"] = port
        threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        url = f"http://127.0.0.1:{port}/__e2e"
        proc = REAL_POPEN([browser, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
                           "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
                           f"--user-data-dir={profile}", "--window-size=1500,1000", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not results.done.wait(TIMEOUT):
            print("Browser tests timed out.")
            return None
        return results.data
    finally:
        if proc:
            stop_browser(profile, proc)
        if srv:
            srv.shutdown()
            srv.server_close()
        s.OPTS["port"] = saved_port
        s.RECORDER = saved_recorder
        box.stop()
        time.sleep(0.2)
        shutil.rmtree(profile, ignore_errors=True)


def report(data, update=False):
    if data is None:
        return False
    failed = [t for t in data["tests"] if not t["ok"]]
    if update:
        GOLDEN.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN.write_text(json.dumps(data["golden"], indent=1, sort_keys=True) + "\n", "utf-8")
        if data.get("real"):
            LOCAL_GOLDEN.parent.mkdir(parents=True, exist_ok=True)
            LOCAL_GOLDEN.write_text(json.dumps(data["real"], indent=0, sort_keys=True), "utf-8")
    for t in failed:
        print(f"FAIL {t['name']}\n     {t.get('error', '')[:600]}")
    print(f"Browser: {len(data['tests']) - len(failed)} passed, {len(failed)} failed ({data.get('ms', 0) / 1000:.1f} s)")
    for e in (data.get("pageErrors") or [])[:10]:
        print("page error:", str(e)[:300])
    return not failed and not data.get("pageErrors")


if __name__ == "__main__":
    real_mode = "--real" in sys.argv
    update_mode = "--update-golden" in sys.argv
    ok = report(run(real_mode, update_mode), update_mode)
    sys.exit(0 if ok else 1)
