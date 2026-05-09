File Guard PI Extension

Version: 1.0.0

PI agent extension that blocks file deletion commands (rm, unlink, find -delete, truncate, shred,
mv to /dev/null, language one-liners) and queues them for user approval.
The agent continues immediately — the user can approve or reject pending
deletions at any time via slash commands.

Commands:\
&emsp;&emsp;/approve-delete [N]   — Approve and execute deletion N (or most recent)\
&emsp;&emsp;/reject-delete [N]    — Reject deletion N (or most recent)\
&emsp;&emsp;/approve-all-deletes  — Approve all pending deletions\
&emsp;&emsp;/reject-all-deletes   — Reject all pending deletions
