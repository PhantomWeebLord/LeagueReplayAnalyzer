"""
Build "Replay Analyzer v2.exe" (a single self-contained Windows executable) with PyInstaller.

    python -m pip install --user pyinstaller      (once)
    python build_exe.py                            -> dist/Replay Analyzer v2.exe
    python build_exe.py --seed                     also copies this folder's cache/ and config.json into the exe's
                                                   data folder (%LOCALAPPDATA%\\League Replay Analyzer)
"""
import hashlib
import io
import math
import os
import shutil
import struct
import subprocess
import sys
import urllib.request
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "build"
NAME = "Replay Analyzer v2"
# Microsoft's WebView2 loader, the small DLL that opens the app's window. Fetched at build time and checked against
# these hashes, so the repository holds no binaries and a changed download can't reach the exe.
WEBVIEW2_VERSION = "1.0.4314.35"
WEBVIEW2_URL = f"https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/{WEBVIEW2_VERSION}/microsoft.web.webview2.{WEBVIEW2_VERSION}.nupkg"
WEBVIEW2_PACKAGE_SHA256 = "90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4"
WEBVIEW2_LOADER_SHA256 = "d3fce90bdeecb08596e377dea6a316354dd8949e32ff09b89d51be00c14e21b6"
WEBVIEW2_FILES = {"build/native/x64/webview2loader.dll": "WebView2Loader.dll", "license.txt": "licenses/LICENSE.txt", "notice.txt": "licenses/NOTICE.txt"}


# ---------------------------------------------------------------- icon (drawn in pure Python, no image libraries)
def _png(size, pixel):
    rows = b"".join(b"\x00" + b"".join(bytes(pixel(x, y, size)) for x in range(size)) for y in range(size))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def _mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(p + (q - p) * t for p, q in zip(a, b))


LOGO_TRIANGLE = ((0.34, 0.20), (0.34, 0.80), (0.82, 0.50))


def _triangle_distance(u, v):
    """Signed distance to the play-button triangle (negative inside)."""
    best, inside = 9.0, True
    for i in range(3):
        (ax, ay), (bx, by) = LOGO_TRIANGLE[i], LOGO_TRIANGLE[(i + 1) % 3]
        ex, ey, px, py = bx - ax, by - ay, u - ax, v - ay
        t = max(0.0, min(1.0, (px * ex + py * ey) / (ex * ex + ey * ey)))
        best = min(best, math.hypot(px - ex * t, py - ey * t))
        if ex * py - ey * px > 0:  # on the far side of this edge
            inside = False
    return -best if inside else best


def _logo_sample(u, v, small):
    """The logo at one point: a replay play button split by a win-chance S-curve, Blue's share below it and Red's above,
    with a gold diamond on the turning point. Sizes under 48 px drop the diamond and use a bolder line.
    Returns an RGB tuple, or None outside the rounded tile."""
    inset, radius = (0.0, 0.22) if small else (0.015, 0.215)
    half = 0.5 - inset - radius
    qx, qy = abs(u - 0.5) - half, abs(v - 0.5) - half
    edge = math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - radius
    if edge > 0:
        return None
    ink, gold = (11, 15, 23), (255, 209, 102)
    col = _mix((29, 37, 56), (13, 17, 27), v)
    if edge > (-0.028 if small else -0.012):
        col = _mix(col, (255, 255, 255), 0.09 if small else 0.14)
    if small:  # fill more of the tile when there are few pixels
        u, v = 0.5 + (u - 0.5) / 1.16, 0.5 + (v - 0.5) / 1.16
    if _triangle_distance(u, v) - (0.07 if small else 0.065) > 0:
        return col
    wave = 7.0 * (u - 0.54)
    slope = -0.17 * 7.0 / math.cosh(wave) ** 2
    side = (v - (0.50 - 0.17 * math.tanh(wave))) / math.sqrt(1 + slope * slope)  # > 0: below the curve
    col = _mix((98, 172, 255), (38, 98, 224), side / 0.30) if side > 0 else _mix((255, 108, 122), (208, 50, 76), -side / 0.30)
    line, casing = (0.042, 0.070) if small else (0.021, 0.041)
    if abs(side) < casing:
        col = gold if abs(side) < line else ink
    if not small:
        diamond = abs(u - 0.54) + abs(v - 0.50)
        if diamond < 0.118:
            col = gold if diamond < 0.082 else ink
    return col


def _icon_pixel(x, y, n):
    ss = 3 if n >= 128 else 5  # supersampling for smooth edges
    small, total, r, g, b = n < 48, ss * ss, 0.0, 0.0, 0.0
    hits = 0
    for j in range(ss):
        for i in range(ss):
            c = _logo_sample((x + (i + 0.5) / ss) / n, (y + (j + 0.5) / ss) / n, small)
            if c:
                hits += 1
                r, g, b = r + c[0], g + c[1], b + c[2]
    if not hits:
        return (0, 0, 0, 0)
    return (round(r / hits), round(g / hits), round(b / hits), round(255 * hits / total))


def make_icon(path):
    sizes = [16, 24, 32, 48, 64, 128, 256]
    pngs = [_png(s, _icon_pixel) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(sizes))
    entries, offset = b"", 6 + 16 * len(sizes)
    for s, data in zip(sizes, pngs):
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + entries + b"".join(pngs))
    (path.parent / "icon_preview.png").write_bytes(pngs[-1])
    (ROOT / "static" / "logo.png").write_bytes(pngs[-1])  # the app window's icon
    return path


def seed_data_dir():
    dest = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "League Replay Analyzer"
    dest.mkdir(parents=True, exist_ok=True)
    if (ROOT / "cache").exists():
        def newer_only(src, dst):  # never overwrite a newer copy (for example one the app upgraded with Riot API data)
            if not os.path.exists(dst) or os.path.getmtime(src) > os.path.getmtime(dst):
                shutil.copy2(src, dst)
        shutil.copytree(ROOT / "cache", dest / "cache", dirs_exist_ok=True, copy_function=newer_only)
    if (ROOT / "config.json").exists() and not (dest / "config.json").exists():
        shutil.copy2(ROOT / "config.json", dest / "config.json")
    print(f"Seeded {dest}")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def extract_webview2(package: bytes, folder: Path):
    """Unpack the loader and Microsoft's license files, refusing anything that doesn't match the pinned hashes."""
    if _sha256(package) != WEBVIEW2_PACKAGE_SHA256:
        raise SystemExit("The downloaded WebView2 package does not match its pinned hash. Build stopped.")
    with zipfile.ZipFile(io.BytesIO(package)) as z:
        names = {n.lower(): n for n in z.namelist()}
        contents = {dest: z.read(names[src]) for src, dest in WEBVIEW2_FILES.items()}
    if _sha256(contents["WebView2Loader.dll"]) != WEBVIEW2_LOADER_SHA256:
        raise SystemExit("The WebView2 loader does not match its pinned hash. Build stopped.")
    for dest, data in contents.items():
        path = folder / dest
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def get_webview2(folder: Path) -> Path:
    dll = folder / "WebView2Loader.dll"
    ready = dll.is_file() and _sha256(dll.read_bytes()) == WEBVIEW2_LOADER_SHA256 and all((folder / d).is_file() for d in WEBVIEW2_FILES.values())
    if not ready:
        print(f"Downloading WebView2 loader {WEBVIEW2_VERSION}")
        with urllib.request.urlopen(WEBVIEW2_URL, timeout=120) as r:
            extract_webview2(r.read(), folder)
    return folder


def main():
    ico = make_icon(BUILD / "app.ico")
    webview = get_webview2(BUILD / "webview2")
    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--noconsole",
           "--name", NAME, "--icon", str(ico),
           "--add-data", f"{ROOT / 'static'}{os.pathsep}static",
           "--add-data", f"{webview / 'licenses'}{os.pathsep}licenses/webview2",
           "--add-binary", f"{webview / 'WebView2Loader.dll'}{os.pathsep}.",
           "--distpath", str(ROOT / "dist"), "--workpath", str(BUILD / "pyi"), "--specpath", str(BUILD),
           str(ROOT / "server.py")]
    print(" ".join(f'"{c}"' if " " in c else c for c in cmd))
    subprocess.check_call(cmd, cwd=str(ROOT))
    exe = ROOT / "dist" / f"{NAME}.exe"
    notices = ROOT / "dist" / "third-party"     # published next to the exe, as Microsoft's license requires
    notices.mkdir(parents=True, exist_ok=True)
    shutil.copy2(webview / "licenses" / "LICENSE.txt", notices / "WebView2-LICENSE.txt")
    shutil.copy2(webview / "licenses" / "NOTICE.txt", notices / "WebView2-NOTICE.txt")
    print(f"\nBuilt {exe} ({exe.stat().st_size / 1e6:.1f} MB)")
    if "--seed" in sys.argv:
        seed_data_dir()


if __name__ == "__main__":
    main()
