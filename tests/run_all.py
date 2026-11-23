"""Runs every test: Python unit and integration tests, then the browser suite.

    python tests/run_all.py          everything, using your local replays too when they exist
    python tests/run_all.py --fast   skip the local-replay comparison
"""
import sys
import unittest
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True


def main():
    warnings.simplefilter("ignore", ResourceWarning)
    suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"), top_level_dir=str(ROOT))
    py = unittest.TextTestRunner(verbosity=0, buffer=True).run(suite)
    py_ok = py.wasSuccessful()
    from tests import browser
    use_real = "--fast" not in sys.argv and (ROOT / "cache").is_dir() and browser.LOCAL_GOLDEN.exists()
    data = browser.run(real=use_real)
    js_ok = browser.report(data)
    n_js = len(data["tests"]) if data else 0
    print(f"\nTOTAL: {py.testsRun + n_js} tests ({py.testsRun} Python, {n_js} browser) - {'ALL PASSED' if py_ok and js_ok else 'FAILED'}")
    return 0 if py_ok and js_ok else 1


if __name__ == "__main__":
    sys.exit(main())
