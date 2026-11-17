# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Latent Grounds Cafe MCP server. The five captured tools of the labelled subset are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `get_menu`, `order_drink`, `check_order`, `read_guestbook`, `look_around`. The captured `sign_guestbook` and `say_at_bar` tools are deliberately omitted: the first posts a caller-authored entry to the public guestbook, and the second sends a caller-authored chat message into the shared lounge; this rebuild does neither. The kept `order_drink` is a free simulated order inside the fiction — it takes only the caller's own self-chosen display name for the cup, no payment and nothing real-world is committed — and the other four kept tools are pure reads.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `cafeporch error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `LATENTGROUNDS_MCP_URL`. The registry record declares no headers on the remote, so no auth header is ever sent.
