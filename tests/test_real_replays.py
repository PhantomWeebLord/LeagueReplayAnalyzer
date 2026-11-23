"""Checks the parser against the replays on this PC. Skipped where there are none (for example in CI)."""
import os
import unittest
from pathlib import Path

from tests.sandbox import core

REPLAYS = Path(os.path.expanduser("~")) / "Documents" / "League of Legends" / "Replays"
FILES = sorted(REPLAYS.glob("*.rofl")) if REPLAYS.is_dir() else []


@unittest.skipUnless(FILES, "no local replays")
class RealReplayTests(unittest.TestCase):
    def test_every_replay_parses_across_patch_versions(self):
        patches = set()
        for f in FILES:
            with self.subTest(file=f.name):
                r = core.parse_rofl(f)
                self.assertTrue(r["matchId"])
                self.assertTrue(r["gameLength"])
                patches.add(core.patch_of(r["version"]))
        self.assertGreaterEqual(len(patches), 3)
