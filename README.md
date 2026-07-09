# hcpss-status-monitor

## Discord webhook status behavior

When a status update is sent, the monitor now uses a **delete-previous-then-post-new** flow:

1. Read the previously sent Discord webhook message ID from local state.
2. Attempt to delete that previous message.
3. Post the new status message (`wait=true`) and store the new message ID.

If no previous ID exists, it simply posts a new message.  
If deletion fails (for example not found or permission-related responses), the monitor logs a warning and continues.  
If posting fails, the stored previous message ID is left unchanged.

Both the scheduled workflow and the on-demand workflow use the same persisted webhook state (`last_message_state.json`) so each new alert replaces the last posted status message instead of stacking.

## Environment variables

- `DISCORD_WEBHOOK_URL` (required for posting to Discord)
- `DISCORD_WEBHOOK_STATE_FILE` (optional): path to the JSON state file used to persist the last webhook message ID.  
  Default: `last_message_state.json`