"""Isolation for every test: temp data folders, no internet, no child processes, no League client, no window control."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True

import lra_core as core  # noqa: E402


def _blocked_network(*_a, **_k):
    raise urllib.error.URLError("network blocked by the test sandbox")


def _blocked_process(*a, **_k):
    raise AssertionError(f"test tried to start a process: {a!r}")


class Sandbox:
    def __init__(self):
        self.patches = []
        self.dir = None

    def patch(self, target, attr, value):
        p = mock.patch.object(target, attr, value)
        p.start()
        self.patches.append(p)
        return value

    def start(self):
        env = mock.patch.dict(os.environ)
        env.start()
        self.patches.append(env)
        os.environ.pop("RIOT_API_KEY", None)
        self.dir = Path(tempfile.mkdtemp(prefix="lra_test_"))
        (self.dir / "cache").mkdir()
        (self.dir / "replays").mkdir()
        for attr, value in (("DATA", self.dir), ("CACHE", self.dir / "cache"), ("CONFIG_FILE", self.dir / "config.json"), ("LIVE_DIR", self.dir / "live"),
                            ("DEFAULT_REPLAY_DIR", self.dir / "replays"), ("_champ_table", None), ("_dd_version", None), ("rejected_keys", set()),
                            ("_meta_cache", {}), ("_cv", {"v": None, "at": 0.0}), ("_ip", {"v": None, "at": 0.0}), ("_user32", lambda: None),
                            ("find_lockfile", lambda: None), ("league_install_dirs", lambda: []), ("_last_config", {}), ("_dd_retry_at", 0), ("_lockfile_cache", {"at": 0.0, "dir": None, "path": None}), ("RIOT_LIMITER", core.RateLimiter([(100000, 1.0)]))):
            self.patch(core, attr, value)
        self.patch(urllib.request, "urlopen", _blocked_network)
        self.patch(subprocess, "run", _blocked_process)
        self.patch(subprocess, "Popen", _blocked_process)
        self.patch(webbrowser, "open", lambda *_a, **_k: True)
        return self

    def stop(self):
        for p in reversed(self.patches):
            p.stop()
        self.patches.clear()
        shutil.rmtree(self.dir, ignore_errors=True)


class SandboxTest(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox().start()
        self.addCleanup(self.box.stop)
        self.tmp = self.box.dir

    def patch(self, target, attr, value):
        return self.box.patch(target, attr, value)
