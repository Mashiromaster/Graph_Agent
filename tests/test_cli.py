from __future__ import annotations

import io
import json
import unittest
from unittest.mock import patch

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

    def test_controller_demo_runs_without_api_key(self) -> None:
        stdout = io.StringIO()

        exit_code = main(["controller-demo"], stdout=stdout)

        self.assertEqual(0, exit_code)
        result = json.loads(stdout.getvalue())
        self.assertEqual("succeeded", result["status"])
        self.assertEqual(2, len(result["nodes"]))
        self.assertEqual(["spawn"], [edge["type"] for edge in result["edges"]])
        self.assertEqual(0, result["budget"]["reserved_tokens"])
        self.assertTrue(result["controller_event_chain_valid"])

    @patch("graph_agent.cli.serve_ui")
    def test_ui_command_launches_local_studio(self, serve_ui) -> None:
        exit_code = main(
            ["ui", "--host", "127.0.0.1", "--port", "9876", "--no-browser"]
        )

        self.assertEqual(0, exit_code)
        serve_ui.assert_called_once_with(
            host="127.0.0.1", port=9876, open_browser=False
        )


if __name__ == "__main__":
    unittest.main()
