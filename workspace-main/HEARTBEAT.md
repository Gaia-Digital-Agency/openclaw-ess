# HEARTBEAT.md

Default: idle. Wake on:
- User dispatch via gateway (port 19290)
- Scheduled run: hourly status check + queue planning
- Webhook from Payload (article state changes)
- Backlog drain: when wave-N quota underfilled
