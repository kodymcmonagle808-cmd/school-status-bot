# hcpss-status-monitor

Monitors the [HCPSS status page](https://status.hcpss.org) and posts the current operating status to Discord.

Everything runs in the Cloudflare Worker in [`hcpss-worker/`](hcpss-worker/) — see its [README](hcpss-worker/README.md) for setup, features, and deployment. The Worker:

- Checks the status page on each guild's configured schedule (Eastern time) and posts the status embed, replacing the previous message instead of stacking.
- Shows active NWS weather alerts for Howard County on status embeds, plus a Tomorrow Outlook on evening posts.
- Storm mode: checks every 15 minutes during the early-morning decision window when a winter storm alert is active, posting only on real status changes.
- Falls back to the last known status (with a stale banner) if the status page is unreachable.
- Handles slash commands (`/post-status`, `/override`, `/calendar`, `/history`, `/events`, `/stats`, `/setup`, `/announce`) and the interactive control panel.
- Lets anyone opt into DMs on status changes via the `🔔 Notify Me` button.

## Repo layout

- `hcpss-worker/` — the Cloudflare Worker (source, tests, deploy script).
- `.github/workflows/deploy_worker.yml` — runs the worker tests and deploys on push to `main`.
- `.github/workflows/current_status.yml` — manual workflow that triggers an on-demand status post via the Worker (requires the `MANUAL_TRIGGER_TOKEN` secret).

## Tests

```bash
cd hcpss-worker
node --test
```
