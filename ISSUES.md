# Known issues

Bugs found in real use, to fix in the next release. Remove an entry once its fix ships (the
CHANGELOG records it).

Nothing open. The 1.5.0 Telegram issues (topics unusable in the clients, replies that seemed to
vanish, Run now from a button that did nothing) are addressed on `release/1.6.0`: topics are gone,
the draft shows no prose and ends before the reply, a routine tap is acknowledged first. Still to
confirm in real use with a bot token: that the clients render rich messages with `<tg-button-row>`
(a client that cannot gets the HTML form with a keyboard, which is the 1.5.0 look), and that
`editMessageText` with `rich_message` edits a rich message in place.

The five entries found 2026-10-16 on 1.4.2 (ghost built-ins on the Agents page, a
delegated role's `maxTurns:`, runaway output on a small provider model, the silent subscription
fallback of a project without `providers:`, MCP tool names) are fixed on `release/1.5.0`; see the
1.5.0 section of `CHANGELOG.md`. Still to confirm in real use: that `context:` makes the CLI
compact a long role on a 64k Ollama box before the window shifts.
