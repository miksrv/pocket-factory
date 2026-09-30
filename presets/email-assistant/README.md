# Email Assistant

Turns "answer the mail from X about Y" into a draft in your Gmail, and "what came in today" into a short list. The mail tools come from the **claude.ai Gmail connector**, the same one Claude Desktop uses: no OAuth client of your own, no token files.

**Adds**

- agent `email-assistant` — searches, reads, summarises and creates or updates reply drafts in the thread. Its `tools:` allowlist names eight connector tools (search, thread, message, labels, drafts); the connector's send, reply, forward, trash and label tools exist but are not on the list.
- skill `email-reply` — the flow: intent → the agent → a short report with the open points → "Draft saved in Gmail".

**Needs**

- The factory logged into claude.ai, not a setup-token: `docker compose run --rm -it -e CLAUDE_CODE_OAUTH_TOKEN= supervisor claude auth login` once (prints a URL, paste the code back), and `CLAUDE_CODE_OAUTH_TOKEN` left empty in `.env`, since a token there takes precedence and hides the connectors.
- Gmail connected at claude.ai → Settings → Connectors with the same account. `claude mcp list` in the container then shows `claude.ai Gmail: … ✔ Connected`.
- The connector serves the Gmail of that claude.ai account. For another mailbox, add a server of the agent's own in Agents → email-assistant → "MCP servers of this role" (for example `npx -y @gongrzhe/server-gmail-autoauth-mcp@1.1.11` with `GMAIL_OAUTH_PATH` / `GMAIL_CREDENTIALS_PATH` pointing at that mailbox's OAuth client and token under `data/secrets/gmail/<box>/`, logged in on the laptop) and its read / draft tools to `tools:`.

**Usage from Telegram**

> "Answer the letter from the recruiter: I am not looking right now, thanks" "What came in today?" "Draft a reply to the invoice mail — we pay on Friday, in English"
