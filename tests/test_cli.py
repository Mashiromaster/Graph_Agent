from __future__ import annotations

import io
import json
import unittest

from graph_agent.cli import main


class CLITests(unittest.TestCase):
    def test_demo_runs_without_api_key(self) -> None:
        stdout = io.StringIO()

        exit_code = main(["demo"], stdout=stdout)

        self.assertEqual(0, exit_code)
        result = json.loads(stdout.getvalue())
        self.assertEqual("completed", result["status"])
        self.assertEqual("offline-demo", result["node_id"])
        self.assertEqual("42", result["output"])
        self.assertEqual(1, len(result["spawn_proposals"]))
        self.assertTrue(result["event_chain_valid"])


if __name__ == "__main__":
    unittest.main()
