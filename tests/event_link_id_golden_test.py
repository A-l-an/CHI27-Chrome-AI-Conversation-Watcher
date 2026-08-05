#!/usr/bin/env python3
"""Cross-runtime golden check for private Return event links."""

import hashlib
import json
import pathlib
import unittest


FIXTURE_PATH = (
    pathlib.Path(__file__).parent
    / "fixtures"
    / "private_return_cues_v1_golden.json"
)


class EventLinkGoldenTest(unittest.TestCase):
    def test_python_sha256_matches_shared_vectors(self) -> None:
        fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        for vector in fixture["event_link_vectors"]:
            digest = hashlib.sha256(
                vector["raw_completion_id"].encode("utf-8")
            ).hexdigest()
            self.assertEqual(
                f"evt_{digest[:20]}",
                vector["event_link_id"],
                vector["raw_completion_id"],
            )


if __name__ == "__main__":
    unittest.main()
