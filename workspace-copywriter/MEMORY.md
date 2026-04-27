# MEMORY.md

Long-term memory store for this agent. Use sparingly — only persist:
- Patterns that proved effective (article structures that landed well in SEO)
- Style notes per persona (after human approval feedback)
- Crawler discovery: which benchmark sites cover what topics best
- Slugs and source-URL hashes already produced (idempotency)

Do NOT persist:
- Drafts (Payload owns those)
- API keys or credentials
- Personal data of any kind
