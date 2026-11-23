"""
Local server for the training page (train/train.html). Serves the app's static files, the downloaded high-elo games and
your cached games, and lets the page save its results.

    python train/train_server.py      then open http://127.0.0.1:8771/
"""
import gzip
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
STATIC = ROOT / "static"
DATA = HERE / "data"
OUT = HERE / "out"
CACHE = ROOT / "cache"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8771
ID_RE = re.compile(r"^[A-Z0-9]{2,5}_\d{6,14}$")
NAME_RE = re.compile(r"^[\w.-]{1,80}$")
TYPES = {".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".json": "application/json", ".png": "image/png"}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _local(self):
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        ok = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
        return host in ok and (origin is None or origin in {f"http://{h}" for h in ok})

    def send(self, code, body, ctype="application/json"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def file(self, base, rel):
        p = (base / rel).resolve()
        if base.resolve() not in p.parents or not p.is_file():
            return self.send(404, '{"error":"not found"}')
        self.send(200, p.read_bytes(), TYPES.get(p.suffix, "application/octet-stream"))

    def do_GET(self):
        if not self._local():
            return self.send(403, '{"error":"forbidden"}')
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path
        if p == "/":
            self.send_response(302)
            self.send_header("Location", "/train/train.html")
            self.end_headers()
            return
        if p == "/api/list":
            return self.send(200, json.dumps(sorted(x.name[:-8] for x in DATA.glob("*.json.gz"))))
        if p == "/api/game":
            i = q.get("id", "")
            f = DATA / f"{i}.json.gz"
            if not ID_RE.match(i) or not f.exists():
                return self.send(404, '{"error":"not found"}')
            return self.send(200, gzip.decompress(f.read_bytes()))
        if p == "/api/user-list":
            return self.send(200, json.dumps(sorted(x.stem for x in CACHE.glob("*.json") if ID_RE.match(x.stem))))
        if p == "/api/user-game":
            i = q.get("id", "")
            f = CACHE / f"{i}.json"
            if not ID_RE.match(i) or not f.exists():
                return self.send(404, '{"error":"not found"}')
            return self.send(200, f.read_bytes())
        if p == "/api/config":
            try:
                c = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
            except Exception:
                c = {}
            return self.send(200, json.dumps({"myPuuids": c.get("myPuuids", []), "myNames": c.get("myNames", [])}))
        if p.startswith("/static/"):
            return self.file(STATIC, p[len("/static/"):])
        if p.startswith("/train/"):
            return self.file(HERE, p[len("/train/"):])
        if p.startswith("/out/"):
            return self.file(OUT, p[len("/out/"):])
        self.send(404, '{"error":"not found"}')

    def do_POST(self):
        if not self._local():
            return self.send(403, '{"error":"forbidden"}')
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path != "/api/save" or not NAME_RE.match(q.get("name", "")):
            return self.send(404, '{"error":"not found"}')
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        name = q["name"]
        dest = STATIC / "wp_model.js" if name == "wp_model.js" else OUT / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        tmp.write_bytes(body)
        tmp.replace(dest)
        self.send(200, json.dumps({"saved": str(dest.relative_to(ROOT)), "bytes": len(body)}))


if __name__ == "__main__":
    print(f"Training server on http://127.0.0.1:{PORT}/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
