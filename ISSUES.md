# Known issues

Bugs found in real use, to fix in the next release. Remove an entry once its fix ships (the
CHANGELOG records it).

Nothing open. Still to confirm in real use:

- Telegram: that the clients render rich messages with `<tg-button-row>` (a client that cannot gets
  the HTML form with a keyboard), and that `editMessageText` with `rich_message` edits one in place.
- Providers: that `context:` makes the CLI compact a long role on a 64k Ollama box before the window
  shifts.
