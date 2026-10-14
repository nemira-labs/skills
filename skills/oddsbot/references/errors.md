# OddsBot results, errors and troubleshooting

Commands print JSON results and handled errors on stdout. Diagnostics and
login progress go to stderr. The rules and the
[recovery procedure](../SKILL.md#reconcile-an-unknown-outcome) are in
[SKILL.md](../SKILL.md).

## Result format

Handled failures include `error`, `state` and `next_action`. API response
errors also include `http_status`; connection and login validation errors may
not. Invalid JSON or HTML is reported as `invalid_response` and is never
printed as successful data.

Exit code 1 means failure, and 42 means authentication could not be verified
for the pinned connection. `state: "unknown"` does not establish whether an
earlier mutation succeeded. Keep its intent and receipt, including any
`known_result`, and reconcile it before placing another order. A failed
`positions --all` returns `incomplete_positions` with the available halves;
it is not complete portfolio data.

`--json` is accepted on each named command, including `help`; JSON is already
the default except for help. On the generic `api` command, `--json` supplies
the request body. In a terminal, plain `login` prints its authorization link
on stderr, prompts for the approval code and prints one final result on
stdout. Without a terminal it behaves like `login --no-poll`.

## Order and quote outcomes

Read `state` before deciding whether to retry. `intent_conflict` and
interrupted requests can describe an unresolved earlier order. Authorization
and request-validation failures can occur before an audit row exists.

| HTTP | `error` | Meaning |
|---|---|---|
| 403 | `spend_limit_exceeded` | per-order, daily or account cap; the response includes `limits`. Relay it and never retry |
| 403 | `authorization_required` | the grant or wallet authorization changed; stop and ask the user to review the connection |
| 409 | `intent_conflict` | this ID belongs to a different payload; reconcile the original intent |
| 403 | `trading_paused` | the user's kill switch is on; stop and tell the user |
| 403 | `loss_cap_exceeded` | loss evidence is unavailable or the limit was reached; stop and relay the reason |
| 403 | `concentration_exceeded` | market or event exposure exceeds the limit or cannot be verified |
| 422 | `price_sanity` | the price is far through the live midpoint; re-price, or use `--allow-off-market` only on the user's explicit say-so |
| 422 | `market_rejected` | tick, minimum size, no book, or (for market orders) slippage or depth |
| 409 | `unsupported_market_version` | quote refused: the market is Protocol V2 or has no protocol version (`state: nothing_placed`) |
| 409 | `quote_expired` | the stored quote expired; reconcile the intent before preparing a replacement |
| 202 | `pending_approval` | above the user's confirmation threshold; held for the human |
| 409 | `pending_approval` | replay of a rejected or expired hold; read its final status and recovery action |
| 502 | `order_failed` | the exchange rejected it (`state: nothing_placed`) or the request died in flight (`state: unknown`; reconcile the same intent) |

An interrupted order request returns `order_request_interrupted` with
`state: "unknown"`, the `intent_id` and the `receipt_path`.

## Troubleshooting

- Exit code 42 → credentials may be missing, expired, revoked or bound to
  another server or connection. Verify the server and original account before
  using the login flow. A fresh login does not reconcile previous orders.
- `expired` from `login --code` → the user took longer than 15 minutes.
  Restart the login flow to get a fresh link.
- `denied` from `login --code` → the user denied the request, or five wrong
  approval codes locked it. Restart only if the user wants to.
- "Cannot reach OddsBot" → network problem, or `ODDSBOT_API_URL` points at a
  server that is not running, such as a local development server. Ask the
  user for the correct URL; unset the variable to use the hosted service.
- HTTP 403 `insufficient_scope` → the stored grant predates a newer scope.
  Run `logout`, then the login flow again; the fresh grant includes the
  current default scopes.
- `"onboarded": false` in a response → relay the `guidance` field; the user
  must complete onboarding in the webapp. Do not retry until they have.
- HTTP 429 `rate_limited` on login → too many device or token requests from
  this address in a minute; wait `Retry-After` seconds and never loop.
- Exit code 42 right after a refresh, with "reuse detected" in the server
  reply → the credentials file was copied and used elsewhere, and the whole
  grant was revoked for safety. Tell the user; a fresh login is the only way
  back.
- HTTP 403 `trading_paused` → the user paused all agent trading in OddsBot
  settings. Do not retry or poll; reads and cancels still work.
- `backend_incompatible` → the deployed backend does not carry the order
  contract this CLI requires. That attempt submitted nothing. Report it.
