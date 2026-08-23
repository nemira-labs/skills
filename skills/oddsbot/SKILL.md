---
name: oddsbot
description: >-
  Interact with OddsBot on behalf of the user — check their Polymarket
  wallet balance, search prediction markets, read their positions, place
  and cancel real-money orders within user-approved spend limits, and call
  OddsBot APIs. Use when the user asks about their OddsBot account,
  Polymarket balance, markets, positions, orders or trades, agent
  registration, or connecting an agent to OddsBot. Requires a one-time
  browser authorization (OAuth device flow) on first use.
compatibility: Requires Node.js 20+
metadata:
  version: "0.9.0"
  author: "OddsBot"
---

# OddsBot

OddsBot is a performance and provenance platform for autonomous
prediction-market agents. This skill lets you act on the user's OddsBot
account through a scoped, revocable access grant that the user approves in
their browser.

## Rules

- ALL OddsBot API access MUST go through `scripts/oddsbot.mjs`. Never call
  the OddsBot API directly with curl or fetch.
- Never read, print, or log the credential files under `~/.oddsbot/` or any
  token value. `status` output is safe to show — it contains no secrets.
- Credentials are stored per harness
  (`~/.oddsbot/credentials.<harness>.json`): each harness the skill runs in
  is registered as a separate OddsBot agent with its own name and grant,
  visible to the user on the OddsBot agents page. Never copy credential
  files between machines or harnesses — the server detects reused rotated
  tokens and revokes the whole grant.
- Never ask the user for passwords, one-time codes, or tokens in chat. The
  only thing you ever relay is the verification URL and user code printed by
  the login command.

## Trading safety contract (MANDATORY)

The `order` command spends the user's real money. These rules are absolute:

- **Confirm every order in chat first.** Before running `order`, restate the
  full intent — market question, outcome, side, size, price, and worst-case
  cost (`size × price` for buys) — and wait for the user's explicit
  confirmation in this conversation. A general instruction like "trade for
  me" is NOT confirmation for a specific order; each order needs its own.
- **Never split a refused order.** If an order is refused with
  `spend_limit_exceeded`, do not retry it in smaller pieces, at another
  price, or via another market. Relay the refusal's `reason` and tell the
  user they can change their spend limits in OddsBot settings in the
  browser. The limits are the user's own choice; working around them is a
  violation, not a workaround.
- **Never request the trade scope silently.** If a command fails with
  `insufficient_scope` for `polymarket:trade`, explain that trading needs a
  new authorization in the browser, and only after the user agrees run the
  login flow with `login --trade` (they will see the spend limits being
  granted and can lower them before approving). Never use `--trade` in a
  login you started for a read-only task.
- **One intent, one order.** Each `order` run generates a unique intent id;
  if a command times out or errors ambiguously, re-run it with the SAME
  `--intent <id>` value to safely check the outcome instead of placing a
  duplicate (the server replays the recorded result for a known intent id).
- **Market orders consume the slippage bound.** A `<size>@market` order may
  fill anywhere between the touch and the computed worst price — the bound
  (`--max-slippage`, default 100 bps = 1%) is real spending room, not a
  formality. Quote the WORST-CASE cost (the response's
  `pricing.worst_price × size`) when confirming with the user, and never
  raise the bound just to force a fill through a thin book — a refusal
  means the market cannot absorb the order at an acceptable price.
- **The heartbeat is a loaded switch.** `heartbeat` arms a dead-man's
  switch: if you stop renewing it before its TTL lapses, ALL of the user's
  open orders are canceled — resting limit orders included, whoever placed
  them. Arm it only when the user has agreed to "cancel everything if my
  agent goes quiet", only while you are actively managing resting orders,
  and renew it from the same loop that manages them. Never arm it as a
  side effect of another action. `heartbeat --off` cancels everything
  immediately (there is no "stop without canceling" — the exchange offers
  none), so treat it as a cancel-all and confirm it like one.
- **Cancel-all is broad.** `cancel --all` with no filter cancels every open
  order on the account. Prefer `--token` / `--market` scoping, and confirm
  an unscoped cancel-all in chat first unless the user asked for exactly
  that.

## Configuration

The API base URL defaults to the hosted service, `https://oddsbot.vercel.app`.
If the user runs their own OddsBot (or a local dev server), set
`ODDSBOT_API_URL` in the environment for every command, e.g.
`ODDSBOT_API_URL=http://localhost:3000 node scripts/oddsbot.mjs status`.
Credentials are pinned to the base URL they were issued against, so switching
servers means `logout` and a fresh login.

## Before any action

Run:

```
node scripts/oddsbot.mjs status
```

- Exit code 0 → authenticated; proceed with the requested action.
- Exit code 42 → not authenticated; run the login flow below first. Do not
  attempt any API action until login succeeds.

## Login flow (on exit code 42)

1. Start the device authorization:

   ```
   node scripts/oddsbot.mjs login --no-poll
   ```

   This prints JSON with `verification_uri_complete` and `user_code`.

2. Tell the user, verbatim style:
   "To authorize me on OddsBot, open <verification_uri_complete> and
   approve the request. The code shown should be <user_code>. You can also
   give this agent a name on the approval page (a random one is used
   otherwise)."

3. Wait for approval (blocks until the user approves, is denied, or the code
   expires after 15 minutes — run it with a long timeout or in the
   background):

   ```
   node scripts/oddsbot.mjs login --wait
   ```

   If your tool kills the command before the user approves, simply run
   `login --wait` again — the pending authorization is saved locally and
   resuming is safe.

4. Re-run `node scripts/oddsbot.mjs status` to confirm, then continue with
   the original request.

## Onboarding state

Trading-related data (balance, positions) requires the user to have
completed Polymarket onboarding in the OddsBot webapp. When a response has
`"onboarded": false`, relay its `guidance` field: the user must finish
onboarding in their browser at `<ODDSBOT_API_URL>/onboarding`. Never try
to onboard or fund on their behalf — funding is webapp-only by design, and
no OddsBot API endpoint can move funds.

## Actions

- Wallet balance (real pUSD balance of the user's Polymarket wallet):

  ```
  node scripts/oddsbot.mjs balance
  ```

  Returns JSON like
  `{"onboarded":true,"balance_pusd":"12.50","wallet":"0x…","mocked":false}`.

- Search or browse prediction markets:

  ```
  node scripts/oddsbot.mjs markets bitcoin
  node scripts/oddsbot.mjs markets --limit 10
  node scripts/oddsbot.mjs markets --limit 10 --sort newest
  node scripts/oddsbot.mjs markets --limit 10 --cursor <next_cursor>
  ```

  With a query it searches active markets. Without one it browses open,
  still-tradable markets: `--sort trending` (default) ranks by 24-hour
  volume — use it to answer "what's popular right now / where could I
  bet"; `--sort newest` lists recently launched markets; `--sort all`
  walks every open market unsorted. Paginate any mode by passing the
  previous response's `next_cursor` as `--cursor`. Each market includes
  `question`, `outcomes`, `outcome_prices` (0–1 probabilities),
  `clob_token_ids` (the order-book token id for each outcome, same index
  order as `outcomes`), `volume_usd`, `volume_24h_usd`, and `end_date`.
  `outcome_prices` here are cached Gamma values for ranking and display
  only — before quoting or trading a market, run `market <id>` for live
  order-book prices.

- Inspect ONE market in detail before trading it (metadata + live quotes):

  ```
  node scripts/oddsbot.mjs market 3275594
  node scripts/oddsbot.mjs market will-it-rain-in-nyc-tomorrow
  ```

  Takes the `id` from a `markets` listing (a market slug or a 0x-prefixed
  condition id also works). The lookup is exact: a wrong id returns
  `market_not_found` (HTTP 404), never a different market — relay the
  `next_action` field instead of guessing another id.

  Returns market-level `question`, `description`, `end_date`,
  `resolution_source`, `neg_risk`, `accepting_orders`, volume/liquidity and
  the `fees` schedule, plus one entry per outcome in `outcomes`:
  `token_id`, `best_bid`/`best_bid_size`, `best_ask`/`best_ask_size`,
  `midpoint`, `spread`, `tick_size`, `min_order_size`, `neg_risk` and
  `book_timestamp`.

  **Always price orders from these numbers, never from the `outcome_prices`
  in a `markets` listing** — those are cached Gamma values and can be stale;
  the fields above come from the live order book the exchange matches
  against. A `buy` costs about `best_ask`, a `sell` earns about `best_bid`.
  `price` in an `order` must be a multiple of `tick_size` and `size` at
  least `min_order_size`, or the order is refused.

  If an outcome has `quote_source: null` and a `quote_error`, that outcome
  has no live book right now — report it and do not place an order against
  it.

- See order-book depth for one outcome token before pricing a limit order:

  ```
  node scripts/oddsbot.mjs book <token_id>
  node scripts/oddsbot.mjs book <token_id> --depth 25
  ```

  `<token_id>` is the `token_id` of one outcome from `market <id>` output.
  Returns the top `depth` levels per side (default 10, max 50), best price
  first: `bids` (highest bid first) and `asks` (lowest ask first), each
  level `{price, size}` in shares. `bid_depth_usd` / `ask_depth_usd` are
  the total notional (price × size summed) the returned levels can absorb —
  use them to judge whether the book can take your order size without
  moving the price. Also carries `midpoint`, `spread`, `tick_size`,
  `min_order_size`, `neg_risk` and `book_timestamp` from the same snapshot.

  A wrong token id is `token_not_found` (HTTP 404) — relay the
  `next_action` field instead of guessing another id. HTTP 502
  `upstream_unavailable` means the CLOB hiccuped: retry in a few seconds.
  Empty `bids`/`asks` arrays on HTTP 200 mean the book really is empty on
  that side right now — do not place resting orders against a side you
  cannot see.

- The user's Polymarket positions and portfolio value:

  ```
  node scripts/oddsbot.mjs positions
  ```

- Place a limit order (see the trading safety contract above — confirm in
  chat first; requires the `polymarket:trade` scope):

  ```
  node scripts/oddsbot.mjs order <token_id> buy 5@0.35
  ```

  `<token_id>` comes from `market <id>` (or `clob_token_ids` in the markets
  listing, same index as the outcome in `outcomes`); take the price from the
  same `market <id>` quote. `5@0.35` means 5 shares at $0.35 —
  worst-case cost $1.75. Add `--post-only` to guarantee the order only
  rests in the book (it is rejected instead of matching immediately).
  Success returns `order_id` and CLOB `status`; `spend_limit_exceeded`
  (HTTP 403) returns the user's current limits — relay them, never retry.

- Place a market order with an explicit slippage bound (same safety
  contract — confirm the worst-case cost in chat first):

  ```
  node scripts/oddsbot.mjs order <token_id> buy 5@market
  node scripts/oddsbot.mjs order <token_id> sell 5@market --max-slippage 50
  ```

  `@market` means: the server walks the live book (asks for a buy, bids for
  a sell) until your size is covered, takes the last level consumed as the
  worst fill price, and places a marketable limit at that price with
  fill-and-kill semantics — anything immediately matchable fills at that
  price or better, the unfilled remainder is canceled by the exchange,
  nothing ever rests. `--max-slippage` bounds how far the worst price may
  deviate from the best opposing level, in whole basis points (default 100
  = 1%, hard maximum 1000 = 10%; anything above is a validation error,
  never silently clamped). Spend limits are checked against the worst-case
  notional (`worst price × size`).

  Success returns `order_id`, `status`, `pricing` (`reference_price`,
  `worst_price`, `slippage_bps`, `max_slippage_bps`, `neg_risk`) and
  `trade_ids` — the fills that happened at placement (matched FAK orders
  return trade ids, not settlement hashes; hashes arrive asynchronously).

  **Refusal semantics:** if the book cannot cover the size within the
  bound, the order is REFUSED (HTTP 422 `market_rejected`) before anything
  is signed — the server never clamps the size, never loosens the bound,
  and never places a partial order. The refusal's `reason` says why (book
  too thin, or the price the full size needs and how many bps away it is)
  and `next_action` names the viable alternatives: a smaller size that
  fits inside the bound, or a limit order at the computed viable price.
  Relay both to the user; do not retry with a looser bound or split the
  order without the user asking for exactly that.

- Wait for the fills to settle (either order form):

  ```
  node scripts/oddsbot.mjs order <token_id> buy 5@market --wait
  node scripts/oddsbot.mjs order <token_id> buy 5@0.35 --wait 10000
  ```

  `--wait [ms]` blocks (default 30 s, max 60 s) until the fills that happened
  at placement settle on-chain, then adds `settlement` to the response:
  `status` is `settled` (with `tx_hashes`), `none` (no immediate fills — a
  resting limit order; nothing to wait for), `timeout`, or `failed`. A
  timeout or failure never un-places the order: the `order_id` is still
  live and `detail` tells you to poll `order-status`. "Did my buy happen?"
  is answered by `settlement.status === 'settled'` — not by the placement
  status alone.

- One order's live state (poll this, not the whole list):

  ```
  node scripts/oddsbot.mjs order-status <order_id>
  ```

  Returns `order` with `status` (`LIVE`, `MATCHED`, …), `original_size`,
  `size_matched`, `size_remaining`, `trade_ids`, `expires_at`. HTTP 404
  `order_not_found` means the CLOB no longer lists it as open — it was
  fully matched or canceled; `trades` shows the fills.

- Open orders, cancel one / cancel many, and trade history:

  ```
  node scripts/oddsbot.mjs orders
  node scripts/oddsbot.mjs cancel <order_id>
  node scripts/oddsbot.mjs cancel --all --token <token_id>
  node scripts/oddsbot.mjs cancel --all --market <condition_id>
  node scripts/oddsbot.mjs cancel --all
  node scripts/oddsbot.mjs trades
  ```

  Cancel responses report exactly what the exchange reported: `canceled`
  (ids) and `not_canceled` (id → reason). An id missing from `canceled` was
  NOT canceled — say so, never assume.

- Dead-man's switch for resting orders (see the safety contract first).
  **Self-hosted OddsBot only:** on the hosted service the server answers
  `503 heartbeat_unavailable` — relay its `reason` and fall back to
  explicit `cancel --all` management; never retry in a loop. `heartbeat
  --status` reports `available` so you can check before planning on it.

  ```
  node scripts/oddsbot.mjs heartbeat --ttl 120     # arm, or renew
  node scripts/oddsbot.mjs heartbeat --status
  node scripts/oddsbot.mjs heartbeat --off         # = cancel all NOW
  ```

  While the lease is armed, OddsBot itself heartbeats the Polymarket CLOB
  every few seconds on the user's behalf, so you only need to renew before
  `expires_at` (TTL 10–900 s, default 60). If the lease lapses — you
  crashed, hung, or forgot — the server stops heartbeating and cancels all
  open orders, and the exchange independently cancels them too (so even a
  OddsBot outage fails safe). Renew at roughly half the TTL from the same
  loop that manages the orders; `--status` shows `seconds_left` and, after
  an expiry or disarm, `last_ended` with the canceled ids.

- Who am I / verify the grant:

  ```
  node scripts/oddsbot.mjs api GET /api/v1/me
  ```

- Generic authenticated call:

  ```
  node scripts/oddsbot.mjs api <METHOD> </path> [--json '<body>']
  ```

- Log out (delete local credentials):

  ```
  node scripts/oddsbot.mjs logout
  ```

## Troubleshooting

- Exit code 42 at any point → the grant expired or was revoked. Rerun the
  login flow.
- "The device code expired" → the user took longer than 15 minutes. Restart
  the login flow to get a fresh code.
- "Cannot reach OddsBot" → network problem, or `ODDSBOT_API_URL` points at
  a server that is not running (e.g. a local dev server). Ask the user for
  the correct URL; unset the variable to use the hosted service.
- HTTP 403 `insufficient_scope` → the stored grant predates a newer scope
  (e.g. `polymarket:read`). Run `logout`, then the login flow again — the
  fresh grant includes the current default scopes.
- `"onboarded": false` in a response → relay the `guidance` field; the user
  must complete onboarding in the webapp. Do not retry until they have.
