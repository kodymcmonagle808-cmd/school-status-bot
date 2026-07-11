import json
import tempfile
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

import monitor


class FakeDateTime:
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 1, 1, 0, 10, tzinfo=tz)

    @classmethod
    def utcnow(cls):
        return datetime(2026, 1, 1, 5, 10, tzinfo=timezone.utc)


class NonDailyDateTime:
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 1, 1, 10, 0, tzinfo=tz)

    @classmethod
    def utcnow(cls):
        return datetime(2026, 1, 1, 15, 0, tzinfo=timezone.utc)


class MonitorWebhookTests(unittest.TestCase):
    def test_split_description_into_embeds_breaks_long_alerts(self):
        long_description = "A" * 8000

        embeds = monitor.split_description_into_embeds(
            title="Status for January 1, 2026",
            description=long_description,
            url="https://hcpss.org",
            color=15158332,
            footer_text="Test Footer",
        )

        self.assertGreater(len(embeds), 1)
        self.assertTrue(all(len(embed["description"]) <= 4096 for embed in embeds))
        self.assertEqual(embeds[0]["title"], "Status for January 1, 2026")
        self.assertTrue(embeds[1]["title"].endswith("(cont. 2)"))

    def test_load_webhook_state_reads_json_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = f"{tmpdir}/state.json"
            with open(state_path, "w", encoding="utf-8") as f:
                json.dump({"last_message_id": "abc123"}, f)

            with patch.object(monitor, "WEBHOOK_STATE_FILE", state_path):
                state = monitor.load_webhook_state()

            self.assertEqual(state.get("last_message_id"), "abc123")

    def test_main_retains_previous_and_keeps_state_when_post_fails(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            status_path = f"{tmpdir}/last_status.txt"
            state_path = f"{tmpdir}/state.json"
            with open(state_path, "w", encoding="utf-8") as f:
                json.dump({"last_message_id": "old123"}, f)

            get_response = SimpleNamespace(
                text="<html><body></body></html>",
                raise_for_status=lambda: None,
            )
            delete_response = SimpleNamespace(status_code=404)
            post_response = SimpleNamespace(status_code=500)

            with (
                patch.object(monitor, "STATUS_FILE", status_path),
                patch.object(monitor, "WEBHOOK_STATE_FILE", state_path),
                patch.object(monitor, "WEBHOOK_URL", "https://discord.com/api/webhooks/1/token"),
                patch.object(monitor, "datetime", FakeDateTime),
                patch.object(monitor.pytz, "timezone", return_value=timezone.utc),
                patch.object(monitor.requests, "get", return_value=get_response),
                patch.object(monitor.requests, "delete", return_value=delete_response) as mock_delete,
                patch.object(monitor.requests, "post", return_value=post_response),
            ):
                monitor.main()

            self.assertEqual(mock_delete.call_count, 0)
            with open(state_path, "r", encoding="utf-8") as f:
                state = json.load(f)
            self.assertEqual(state.get("last_message_id"), "old123")

    def test_main_stores_new_message_id_after_successful_post(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            status_path = f"{tmpdir}/last_status.txt"
            state_path = f"{tmpdir}/state.json"

            get_response = SimpleNamespace(
                text="<html><body></body></html>",
                raise_for_status=lambda: None,
            )
            post_response = SimpleNamespace(
                status_code=200,
                json=lambda: {"id": "new456"},
            )

            with (
                patch.object(monitor, "STATUS_FILE", status_path),
                patch.object(monitor, "WEBHOOK_STATE_FILE", state_path),
                patch.object(monitor, "WEBHOOK_URL", "https://discord.com/api/webhooks/1/token"),
                patch.object(monitor, "datetime", FakeDateTime),
                patch.object(monitor.pytz, "timezone", return_value=timezone.utc),
                patch.object(monitor.requests, "get", return_value=get_response),
                patch.object(monitor.requests, "delete", return_value=SimpleNamespace(status_code=204)),
                patch.object(monitor.requests, "post", return_value=post_response),
            ):
                monitor.main()

            with open(state_path, "r", encoding="utf-8") as f:
                state = json.load(f)
            self.assertEqual(state.get("last_message_id"), "new456")

    def test_main_does_not_post_when_only_status_date_changes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            status_path = f"{tmpdir}/last_status.txt"
            state_path = f"{tmpdir}/state.json"

            with open(status_path, "w", encoding="utf-8") as f:
                f.write("Schools Closed Due to weather")

            html = """
            <html><body>
              <div class="views-row">
                <div class="views-field-changed">January 2, 2026 5:00 AM</div>
                <h2>Schools Closed</h2>
                <p>Due to weather</p>
              </div>
            </body></html>
            """
            get_response = SimpleNamespace(
                text=html,
                raise_for_status=lambda: None,
            )

            with (
                patch.object(monitor, "STATUS_FILE", status_path),
                patch.object(monitor, "WEBHOOK_STATE_FILE", state_path),
                patch.object(monitor, "WEBHOOK_URL", "https://discord.com/api/webhooks/1/token"),
                patch.object(monitor, "datetime", NonDailyDateTime),
                patch.object(monitor.pytz, "timezone", return_value=timezone.utc),
                patch.object(monitor.requests, "get", return_value=get_response),
                patch.object(monitor.requests, "delete") as mock_delete,
                patch.object(monitor.requests, "post") as mock_post,
            ):
                monitor.main()

            self.assertEqual(mock_delete.call_count, 0)
            self.assertEqual(mock_post.call_count, 0)


if __name__ == "__main__":
    unittest.main()
