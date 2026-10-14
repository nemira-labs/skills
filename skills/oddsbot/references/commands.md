# OddsBot CLI command reference

Every command prints JSON on stdout. Run them from the skill root. The rules,
the login flow and the trading safety contract are in [SKILL.md](../SKILL.md).
Order outcomes and troubleshooting are in [errors.md](errors.md).

## Account

Wallet balance, the real pUSD balance of the user's Polymarket wallet:

```
node scripts/oddsbot.mjs balance
```

Returns JSON like
`{"onboarded":true,"balance_pusd":"12.50","wallet":"0x…","mocked":false}`.

Who am I, and a generic authenticated call:

```
node scripts/oddsbot.mjs api GET /api/v1/me
node scripts/oddsbot.mjs api <METHOD> </path> [--json '<body>']
```

## Events

Find the event first when the user talks about a topic ("the Fed meeting",
"the election"). Events group related markets, and multi-outcome questions
only make sense at event level.

```
node scripts/oddsbot.mjs events fed
node scripts/oddsbot.mjs events --limit 10
node scripts/oddsbot.mjs events --limit 10 --sort newest
node scripts/oddsbot.mjs events --limit 10 --cursor <next_cursor>
node scripts/oddsbot.mjs event 481717
node scripts/oddsbot.mjs event fed-decision-in-september
```

`events` searches open event titles with a query, or lists open events by
24h volume (`--sort trending`, default) or launch date (`--sort newest`).
`--tag <slug>` narrows a listing to one category from `tags` or `sports`.
Paginate with the previous response's opaque `next_cursor`, keeping the same
query, tag and sort. Numeric offsets from older versions must be replaced by
a fresh first page. A final page returns `next_cursor: null`.

Each row has `id`, `title`, `slug`, `neg_risk`, `market_count`, `tags`,
volume and liquidity, and `end_date`. Missing volume or liquidity is `null`,
not zero.

`event <id|slug>` returns the event plus `markets[]`, every nested market in
the same row shape as `markets`. When `neg_risk` is true the markets are
mutually exclusive outcomes of one question: at most one resolves YES, and
their YES prices should sum to about 1. A wrong id is `event_not_found`
(HTTP 404); relay `next_action` and never guess another id. Nested
`outcome_prices` are cached: run `market <id>` before quoting.

## Markets

```
node scripts/oddsbot.mjs markets bitcoin
node scripts/oddsbot.mjs markets --limit 10
node scripts/oddsbot.mjs markets --limit 10 --sort newest
node scripts/oddsbot.mjs markets --limit 10 --cursor <next_cursor>
```

With a query, `markets` returns a first-page preview of active-market search
results. `search_scope: "first_page"` identifies this preview, and
`truncated: true` means more matches were omitted. Search does not support
`--cursor` or `--tag`, and reads at most 20 events.

Without a query it browses open markets. `--sort trending` (default) ranks by
24-hour volume, `--sort newest` lists recently launched markets, and
`--sort all` walks every open market unsorted. `--tag <slug>` narrows a
sorted listing to one category and cannot be combined with `--sort all`.
Paginate by passing the previous response's `next_cursor` as `--cursor`,
keeping the same sort and tag.

Each market has `question`, `outcomes`, `outcome_prices` (0–1
probabilities), `clob_token_ids` (the order-book token for each outcome, in
the same order as `outcomes`), `position_ids`, `protocol_version`,
`tradable`, `volume_usd`, `volume_24h_usd` and `end_date`. Missing volume or
liquidity is `null`, not zero. Missing prices or token IDs are empty arrays
and do not establish that a market is tradable. `tradable.supported: false`
marks a Protocol V2 market or one without a protocol version; OddsBot
refuses to quote it. `outcome_prices` are cached Gamma values for ranking
and display only.

One market in detail, with live quotes, before trading it:

```
node scripts/oddsbot.mjs market 3275594
node scripts/oddsbot.mjs market will-it-rain-in-nyc-tomorrow
```

The id is the `id` from a `markets` listing; a market slug or a 0x-prefixed
condition id also works. The lookup is exact: a wrong id returns
`market_not_found` (HTTP 404), never a different market. Relay
`next_action` instead of guessing another id.

The result has `question`, `description`, `end_date`, `resolution_source`,
`neg_risk`, `accepting_orders`, `protocol_version`, `position_ids`,
`tradable`, volume and liquidity, and the `fees` schedule. Each entry in
`outcomes` has `token_id`, `best_bid` and `best_bid_size`, `best_ask` and
`best_ask_size`, `midpoint`, `spread`, `tick_size`, `min_order_size`,
`neg_risk` and `book_timestamp`. Malformed metadata or inconsistent
outcome and token arrays return `upstream_unavailable`; this does not mean
the market was confirmed absent.

Price orders from these live numbers, never from `outcome_prices` in a
listing. A `buy` costs about `best_ask`; a `sell` earns about `best_bid`. An
order `price` must be a multiple of `tick_size`, and `size` at least
`min_order_size`, or the order is refused.

An outcome with `quote_source: null` and a `quote_error` has no verified live
quote. `token_not_found` means the exchange returned 404;
`upstream_unavailable` means the request failed or the book was invalid or
inconsistent. Report it and do not place an order against it. Quote
preparation and the fee check before signing require an explicit exchange
fee rate, exponent and taker-only flag. Missing fee metadata is not a zero
fee. A post-only order can still incur fees when the schedule charges
makers, and a changed fee schedule fails the check before signing.

## Order book and price history

```
node scripts/oddsbot.mjs book <token_id>
node scripts/oddsbot.mjs book <token_id> --depth 25
```

`<token_id>` is one outcome's `token_id` from `market <id>`. The result has
the top `depth` levels per side (default 10, max 50), best price first:
`bids` (highest first) and `asks` (lowest first), each `{price, size}` in
shares. `bid_depth_usd` and `ask_depth_usd` are the notional the returned
levels can absorb. It also has `midpoint`, `spread`, `tick_size`,
`min_order_size`, `neg_risk`, `book_timestamp` and `protocol_version` (`v2`
for Protocol V2 books, `null` for CTF books) from the same snapshot.

A wrong token id is `token_not_found` (HTTP 404). HTTP 502
`upstream_unavailable` means the CLOB failed; retry in a few seconds. Empty
`bids` or `asks` on HTTP 200 mean that side of the book really is empty; do
not place resting orders against a side you cannot see.

```
node scripts/oddsbot.mjs history <token_id>
node scripts/oddsbot.mjs history <token_id> --interval 1w --fidelity 60
node scripts/oddsbot.mjs history <token_id>,<second_token_id> --interval 1d --fidelity 60
```

`--interval` is one of `1h`, `6h`, `1d` (default), `1w` or `max`.
`--fidelity` is the bucket width in minutes; the server raises it to the
exchange minimum (`1w` needs at least 5). The result has `points`
(`{t: unix seconds, p: price}`, ascending), `count`, `first`, `last`,
`change` (last − first), `high` and `low`. These are historical price
samples, not live quotes or proof of executed trades. Price an order from
`book` or `market`, never from `last.p`. An empty `points` array means no
samples were returned; it does not prove that no trades occurred.

For a batch, comma-separate up to 20 unique token IDs. The response has
`histories`, one summary per token in request order. An incomplete upstream
token map refuses the batch rather than reporting missing data as zero. If
a response is too large, narrow the interval or increase fidelity.

## Categories: tags, series, sports and teams

A tag slug beats guessing search words for "what NBA / politics / crypto
markets are live" questions.

```
node scripts/oddsbot.mjs tags nba
node scripts/oddsbot.mjs tags --limit 50 --cursor <next_cursor>
node scripts/oddsbot.mjs tag nba
node scripts/oddsbot.mjs series
node scripts/oddsbot.mjs series nfl
node scripts/oddsbot.mjs sports
node scripts/oddsbot.mjs teams nfl
node scripts/oddsbot.mjs events --tag nba --limit 10
node scripts/oddsbot.mjs markets --tag politics --limit 10
```

`tags <query>` returns Gamma's matching tags with `event_count`, the number
of events carrying each one. Without a query it pages the alphabetical
catalogue. Catalogue rows without a slug are omitted. `tag <slug|id>`
returns the tag, its `related_tags` (unranked ones last, `rank: null`) and
its top open `events`. `series` lists recurring series by 24h volume, and
`series <slug|id>` adds the open events. Unavailable series volume or
liquidity is `null`, not zero.

`sports` lists every league with its `league` slug, `name` (the slug when
Gamma has none), `tag_id`, `tag_ids` and `series_ids`. `series_id` is set
only when there is one series; use each individual ID with `series <id>`.
`teams <league>` lists that league's teams (name, abbreviation, record). A
wrong slug is `tag_not_found` or `series_not_found` (HTTP 404); relay
`next_action` and never guess another.

## Market analytics

These are public Polymarket Data API reads, strategy input and never a live
quote. Present them as what other traders are doing, not as a
recommendation.

```
node scripts/oddsbot.mjs holders <condition_id>
node scripts/oddsbot.mjs holders <condition_id> --limit 25
node scripts/oddsbot.mjs open-interest <condition_id>
node scripts/oddsbot.mjs live-volume <event_id>
node scripts/oddsbot.mjs leaderboard
node scripts/oddsbot.mjs leaderboard --window 30d --by vol --category politics --limit 10
node scripts/oddsbot.mjs portfolio <0x address>
```

`<condition_id>` is the 0x… `condition_id` from `market <id>` or a positions
row.

- `holders` returns, per outcome `token_id`, the largest holders: `wallet`,
  public `name` or pseudonym, `shares` and `outcome_index`. `--limit` is per
  outcome, at most 1000.
- `open-interest` is the USD value outstanding on the market. An unknown
  condition is `market_not_found`; the global figure is never substituted.
- `live-volume <event_id>` is the event's cumulative one-side taker volume in
  shares: `taker_volume_shares` in total and per market.
- `leaderboard` is Polymarket's public trader ranking. `--window` is 1d, 7d
  (default), 30d or all; `--by` is pnl (default) or vol; `--category` is one
  of overall, politics, sports, esports, crypto, culture, mentions, weather,
  economics, tech or finance. Rows have `wallet`, `pnl_usd` and
  `volume_shares` (traded volume in shares, not USD).
- `portfolio <address>` is any wallet's public profile,
  `portfolio_value_usd`, `markets_traded` and `top_positions`. A user address
  is resolved to its profile's proxy wallet first. `markets_traded` and
  `weighted_volume_usd` are `null` when unknown, not zero.

Malformed or mismatched upstream data returns `upstream_unavailable`; do not
read it as an empty result.

## Positions

```
node scripts/oddsbot.mjs positions
node scripts/oddsbot.mjs positions --closed
node scripts/oddsbot.mjs positions --all
node scripts/oddsbot.mjs positions --limit 100 --cursor <next_cursor>
```

`positions` lists open positions with a `summary` (`portfolio_value_usd`,
`open_count`, `unrealized_pnl_usd`, `redeemable_count`,
`redeemable_value_usd`). Each row has `token_id` (pass it to `book`,
`history` or `order`), `condition_id`, `market`, `outcome`, `size`,
`avg_price`, `current_price`, `initial_value_usd` (fee-exclusive entry
basis), `current_value_usd`, `pnl_usd` and `pnl_percent` (unrealized),
`end_date`, `neg_risk` and `redeemable`.

`redeemable: true` means the market has resolved, and the row and the
response carry a `next_action`; relay it. The agent API has no redemption
endpoint. The user redeems on their dashboard, where the resolution is
verified on-chain before anything is signed.

`--closed` lists closed positions with `size` (lifetime shares bought),
`realized_pnl_usd`, `exit_price`, `closed_at` (`null` when unrecorded) and a
`summary.realized_pnl_usd`. Pass a page's `next_cursor` as `--cursor` to read
the next page of the same list; `next_cursor: null` ends it. `--all` returns
`{"open": …, "closed": …}` and takes no cursor. All numbers come from the
Polymarket Data API at call time. The server's separate loss ledger verifies
settled activity for risk checks; it does not replace these responses.

## Quotes and orders

Read the [trading safety contract](../SKILL.md#trading-safety-contract-mandatory)
before using these commands.

Prepare exact terms before asking the user to confirm an order:

```
node scripts/oddsbot.mjs quote <token_id> buy 5@0.35 --intent <intent_id>
node scripts/oddsbot.mjs quote <token_id> sell 5@market --max-slippage 50 --intent <intent_id>
```

`quote` stores a two-minute quote without submitting or signing an order and
requires `polymarket:trade`. Show the user its market question, outcome,
side, size, absolute price bound, wallet, activity budget and fee estimate.
Submit the identical terms with `order --intent` and the same intent ID. The
server also prepares a quote when an order has none. Reusing an intent never
changes its quote; changed terms or another grant cause `quote_conflict`.
`quote_expired` and `unsupported_market_version` refusals carry
`state: "nothing_placed"`. `no_order_submitted` describes this quote request
only; it says nothing about earlier execution of the intent.

The price bound limits each fill price. Protocol fees are estimated at that
bound from the current schedule and apply at match time; they can change.
The estimate excludes builder and network charges and is not guaranteed net
proceeds. Activity limits reserve notional, not total wallet costs. Buy fees
can be charged in addition to signed principal. The integration does not
enforce a fee-inclusive spending ceiling, so never present an activity limit
or fee estimate as a maximum wallet debit. This remains a production blocker.
Limit orders can remain open after quote expiry; market-mode orders can fill
partially. Buy market mode commits USD and may receive a different share
count.

Place a limit order:

```
node scripts/oddsbot.mjs order <token_id> buy 5@0.35
```

`5@0.35` means 5 shares at $0.35, a maximum principal of $1.75 before fees.
Take the token and price from the same `market <id>` quote. Add `--post-only`
so the order only rests in the book; it is rejected instead of matching
immediately. Success returns `order_id` and the CLOB `status`.

Place a market order with an explicit slippage bound:

```
node scripts/oddsbot.mjs order <token_id> buy 5@market
node scripts/oddsbot.mjs order <token_id> sell 5@market --max-slippage 50
```

`@market` walks the live book (asks for a buy, bids for a sell) until the size
is covered, takes the last level consumed as the worst fill price, and places
a fill-and-kill marketable limit at that price. Anything immediately
matchable fills at that price or better; the exchange cancels the rest, and
nothing rests. `--max-slippage` bounds how far the worst price may deviate
from the best opposing level, in whole basis points (default 100 = 1%,
maximum 1000 = 10%; anything above is a validation error, never clamped).
Buy activity limits reserve the worst-price principal; sells reserve $1 per
share. Neither bounds total settlement fees. Success returns `order_id`,
`status`, `pricing` (`reference_price`, `worst_price`, `slippage_bps`,
`max_slippage_bps`, `neg_risk`) and `trade_ids`.

If the book cannot cover the size within the bound, the order is refused
with HTTP 422 `market_rejected` before anything is signed. The server never
shrinks the request or loosens the bound. An accepted FAK order can still
fill partially if liquidity changes before execution. The refusal's `reason`
says why, and `next_action` names the alternatives: a smaller size that fits
the bound, or a limit order at the viable price. Relay both; do not retry
with a looser bound or split the order unless the user asks for exactly
that.

Wait for the fills to settle, with either order form:

```
node scripts/oddsbot.mjs order <token_id> buy 5@market --wait
node scripts/oddsbot.mjs order <token_id> buy 5@0.35 --wait 10000
```

`--wait [ms]` blocks (default 30 s, max 60 s) until the fills from placement
settle on-chain, then adds `settlement`: `status` is `settled` (with
`tx_hashes`), `none` (no immediate fills, such as a resting limit order),
`timeout` or `failed`. A timeout or failure never un-places the order: the
`order_id` is still live, and `detail` says to poll the order status. "Did
my buy happen?" is answered by `settlement.status === 'settled'`, not by the
placement status alone. A retry of the same intent may add or drop `--wait`.

## Held orders and recovery

```
node scripts/oddsbot.mjs approval-status <approval_id>
node scripts/oddsbot.mjs approvals
node scripts/oddsbot.mjs intent-status <intent_id>
```

An order above the user's "ask me before orders above $X" threshold is held:
the `order` response has `error: "pending_approval"` plus `approval`
(`approval_id`, `expires_at`, `summary`). After the user decides on the
dashboard, `approval-status` reports `approved` while execution is
unresolved, then `placed` (with `order`, the placement result), `failed`
(with `placement_error`; a guardrail can still refuse at approval time),
`rejected` or `expired`. Approval places the order at that moment's book
through every normal check, within the absolute price bound stored when it
was held. An expired approval, revoked grant or adverse price move refuses
execution. `approvals` lists all of the account's held orders, including
other grants' orders.

Every approval includes the complete typed `outcome` and its original
`grant_id`. `approved` without a recorded result has
`outcome.state: "unknown"`, even after the approval deadline.

`intent-status <intent_id>` is the recovery step described in
[Reconcile an unknown outcome](../SKILL.md#reconcile-an-unknown-outcome).
The result belongs to the current grant. An unknown result may include
`exchange_order_id`, computed and saved before signing; that field alone
does not mean the order was accepted. Recovery may return `status: filled`
with `reconciliation`, identifying a finalized Polygon block and exchange
whose record proves the signed amount was exhausted. It does not establish
net profit, fees or inclusion in the portfolio snapshot, and does not
release the activity budget. The CLI keeps the strongest known result in the
receipt: concurrent or later responses cannot erase a saved acceptance or
replace newer finality with older data.

## Open orders, cancellation and trades

One order's live state:

```
node scripts/oddsbot.mjs order-status <order_id>
```

Returns `order` with `status` (`LIVE`, `MATCHED`, …), `original_size`,
`size_matched`, `size_remaining`, `trade_ids` and `expires_at`. HTTP 404
`order_not_found` does not establish whether the order filled, was canceled
or was ever accepted. Reconcile the original intent and inspect `trades`; do
not create a replacement or release funds based on a 404 alone.

```
node scripts/oddsbot.mjs orders
node scripts/oddsbot.mjs cancel <order_id>
node scripts/oddsbot.mjs cancel --all --token <token_id>
node scripts/oddsbot.mjs cancel --all --market <condition_id>
node scripts/oddsbot.mjs cancel --all
node scripts/oddsbot.mjs trades
```

Each `trades` row describes this wallet's actual fill. Maker rows use the
wallet's own order leg, which can have a different outcome, price or
quantity from the taker's trade. `fill_id` identifies one leg and `id` the
exchange trade. Rows include `order_id`, `role` and `transaction_hash`
(`null` until the fill settles on-chain). Fee rates alone are not proof of
net settlement cash or realized P&L.

Bulk cancel responses keep the exchange's `canceled` ids and `not_canceled`
reasons. Partial cancellation returns HTTP 409 `cancellation_incomplete`. A
single-order cancellation returns a `canceled` boolean and its `order_id`;
an unconfirmed result returns HTTP 409 `cancellation_unconfirmed`. Missing
acknowledgment does not prove that an order is still open or already
canceled; read its status and fills. Even an acknowledged cancellation can
follow a fill, so reconcile before replacing an order or reusing its funds.
API cancellation filters accept only one `token_id` or `condition_id`;
unknown or repeated filters fail.

## Heartbeat

The dead-man's switch for resting orders works on self-hosted OddsBot only;
read the safety contract first. On the hosted service the server answers
`503 heartbeat_unavailable`: relay its `reason`, manage orders with explicit
`cancel --all` instead, and never retry in a loop. `heartbeat --status`
reports `available`.

```
node scripts/oddsbot.mjs heartbeat --ttl 120     # arm, or renew
node scripts/oddsbot.mjs heartbeat --status
node scripts/oddsbot.mjs heartbeat --off         # stop pump and request cancel-all
```

While the lease is armed, OddsBot heartbeats the Polymarket CLOB every few
seconds on the user's behalf, so renew only before `expires_at` (TTL 10–900
s, default 60). Renew at roughly half the TTL from the same loop that
manages the orders. If the lease lapses, the server stops heartbeating and
requests cancellation of open orders; the exchange also documents automatic
cancellation after missed heartbeats. Stopping the pump does not verify that
cancellation occurred.

`--status` shows `seconds_left` and, after an expiry or disarm, `last_ended`
with the canceled ids and any failure. `disarmed: true` means the pump
stopped. A failed cancel request returns HTTP 502
`heartbeat_cancellation_unknown`, and a partial result returns HTTP 409
`cancellation_incomplete`; both have `state: "unknown"`. A late renewal
returns HTTP 409 `heartbeat_expired` and ends the previous lease; reconcile
its cancellation report and fills before starting a new one. Lease operations
are serialized per account within the configured single process, and
heartbeat HTTP requests share a three-second deadline including one
ID-resynchronization retry. A timeout bounds the local wait; it does not
prove what the exchange processed. Generic heartbeat POST requests require a
JSON object with only an optional integer `ttl_sec` from 10 to 900.
