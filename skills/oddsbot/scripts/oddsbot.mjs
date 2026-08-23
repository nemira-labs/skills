#!/usr/bin/env node
// OddsBot agent CLI — zero dependencies, Node 20+.
//
// All OddsBot API access for agents goes through this script. It fails
// closed: any command that needs auth exits with code 42 when credentials
// are missing, expired, or revoked. Token values are never printed.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Each agent harness (Claude Code, OpenClaw, a custom runtime, ...) gets its
// own credentials file and therefore its own OddsBot agent identity — two
// harnesses on the same machine must not share a grant. Detection is
// best-effort from well-known env vars; ODDSBOT_HARNESS overrides.
function detectHarness() {
  const override = process.env.ODDSBOT_HARNESS
  const raw =
    override ||
    (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT
      ? 'claude-code'
      : Object.keys(process.env).some((k) => k.startsWith('OPENCLAW'))
        ? 'openclaw'
        : process.env.CURSOR_TRACE_ID
          ? 'cursor'
          : Object.keys(process.env).some((k) => k.startsWith('CODEX_'))
            ? 'codex'
            : process.env.GEMINI_CLI
              ? 'gemini-cli'
              : 'custom')
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'custom'
}

const HARNESS = detectHarness()
const CRED_DIR = join(homedir(), '.oddsbot')
// Pre-rebrand location (the skill shipped as "polyedge" until 0.8.x). Moved
// wholesale, once, so existing logins survive the rename.
const PRE_REBRAND_CRED_DIR = join(homedir(), '.polyedge')
if (existsSync(PRE_REBRAND_CRED_DIR) && !existsSync(CRED_DIR)) {
  try {
    renameSync(PRE_REBRAND_CRED_DIR, CRED_DIR)
  } catch {
    // fall through: worst case is a fresh login
  }
}
const CRED_PATH = join(CRED_DIR, `credentials.${HARNESS}.json`)
const PENDING_PATH = join(CRED_DIR, `pending-device.${HARNESS}.json`)
const LEGACY_CRED_PATH = join(CRED_DIR, 'credentials.json')
// The hosted OddsBot service. A stored credentials file pins the base it
// was issued against; ODDSBOT_API_URL overrides both (local dev:
// http://localhost:3000).
const DEFAULT_API_BASE = 'https://oddsbot.vercel.app'
const EXIT_UNAUTHENTICATED = 42

// One-time migration from the pre-harness layout: the single shared file was
// one identity, so the first harness that runs claims it.
if (existsSync(LEGACY_CRED_PATH) && !existsSync(CRED_PATH)) {
  try {
    renameSync(LEGACY_CRED_PATH, CRED_PATH)
  } catch {
    // fall through: worst case is a fresh login
  }
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonFile(path, data) {
  mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

function removeFile(path) {
  rmSync(path, { force: true })
}

function apiBase() {
  return (
    process.env.ODDSBOT_API_URL ||
    readJsonFile(CRED_PATH)?.api_base ||
    DEFAULT_API_BASE
  ).replace(/\/$/, '')
}

function die(message, code = 1) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n')
  process.exit(code)
}

function die42() {
  die(
    'Not authenticated with OddsBot.\n' +
      'Run `oddsbot.mjs login --no-poll`, have the user open the printed URL ' +
      'and approve, then run `oddsbot.mjs login --wait`.',
    EXIT_UNAUTHENTICATED,
  )
}

async function post(path, body) {
  let response
  try {
    response = await fetch(apiBase() + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    die(
      `Cannot reach OddsBot at ${apiBase()} (${error.cause?.code ?? error.message}).\n` +
        'Check the network, or set ODDSBOT_API_URL if OddsBot lives elsewhere (e.g. http://localhost:3000 for local dev).',
    )
  }
  const data = await response.json().catch(() => null)
  return { status: response.status, data }
}

async function refreshCredentials() {
  const creds = readJsonFile(CRED_PATH)
  if (!creds?.refresh_token) die42()
  const { status, data } = await post('/api/agent-auth/token', {
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
  })
  if (status !== 200 || !data?.access_token) {
    removeFile(CRED_PATH)
    die42()
  }
  saveTokenResponse(creds, data)
  return readJsonFile(CRED_PATH)
}

function saveTokenResponse(existing, data) {
  writeJsonFile(CRED_PATH, {
    api_base: existing?.api_base ?? apiBase(),
    client_name: existing?.client_name ?? `${HARNESS}@${hostname()}`,
    harness: HARNESS,
    access_token: data.access_token,
    access_token_expires_at: new Date(
      Date.now() + data.expires_in * 1000,
    ).toISOString(),
    refresh_token: data.refresh_token,
    scopes: (data.scope ?? '').split(' ').filter(Boolean),
  })
}

async function ensureAccessToken() {
  let creds = readJsonFile(CRED_PATH)
  if (!creds?.access_token) die42()
  const expiresAt = Date.parse(creds.access_token_expires_at ?? '') || 0
  if (expiresAt - 30_000 < Date.now()) {
    creds = await refreshCredentials()
  }
  return creds.access_token
}

async function apiFetch(method, path, jsonBody) {
  let token = await ensureAccessToken()
  const doFetch = (accessToken) =>
    fetch(apiBase() + path, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(jsonBody !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
    })
  let response = await doFetch(token)
  if (response.status === 401) {
    token = (await refreshCredentials()).access_token
    response = await doFetch(token)
    if (response.status === 401) {
      removeFile(CRED_PATH)
      die42()
    }
  }
  return response
}

// --- commands ---

async function cmdStatus() {
  const creds = readJsonFile(CRED_PATH)
  if (!creds) die42()
  const response = await apiFetch('GET', '/api/v1/me')
  const me = await response.json().catch(() => null)
  if (!response.ok || !me) die42()
  console.log(
    JSON.stringify(
      {
        authenticated: true,
        api_base: apiBase(),
        client_name: me.client_name,
        agent_id: me.agent_id,
        agent_name: me.display_name,
        harness: HARNESS,
        scopes: me.scopes,
        privy_did: me.privy_did,
      },
      null,
      2,
    ),
  )
}

const DEFAULT_SCOPES = ['profile:read', 'wallet:read', 'polymarket:read']

async function cmdLoginStart(withTrade = false) {
  const { status, data } = await post('/api/agent-auth/device', {
    client_name: `${HARNESS}@${hostname()}`,
    harness: HARNESS,
    hostname: hostname(),
    scopes: withTrade
      ? [...DEFAULT_SCOPES, 'polymarket:trade']
      : DEFAULT_SCOPES,
  })
  if (status !== 200 || !data?.device_code) {
    die(`Failed to start device authorization: ${JSON.stringify(data)}`)
  }
  writeJsonFile(PENDING_PATH, {
    api_base: apiBase(),
    device_code: data.device_code,
    interval: data.interval ?? 5,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  })
  console.log(
    JSON.stringify(
      {
        verification_uri_complete: data.verification_uri_complete,
        user_code: data.user_code,
        expires_in: data.expires_in,
        next_step:
          'Ask the user to open the URL and approve, then run `oddsbot.mjs login --wait`.',
      },
      null,
      2,
    ),
  )
}

async function cmdLoginWait() {
  const pending = readJsonFile(PENDING_PATH)
  if (!pending?.device_code) {
    die('No pending device authorization. Run `oddsbot.mjs login --no-poll` first.')
  }
  let interval = (pending.interval ?? 5) * 1000
  const expiresAt = Date.parse(pending.expires_at ?? '') || Date.now() + 900_000

  while (Date.now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, interval))
    const { data } = await post('/api/agent-auth/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: pending.device_code,
    })
    if (data?.access_token) {
      saveTokenResponse(readJsonFile(CRED_PATH), data)
      removeFile(PENDING_PATH)
      console.log(
        JSON.stringify(
          { authenticated: true, scopes: (data.scope ?? '').split(' ') },
          null,
          2,
        ),
      )
      return
    }
    switch (data?.error) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        interval += 5000 // RFC 8628 §3.5
        continue
      case 'access_denied':
        removeFile(PENDING_PATH)
        die('The user denied the authorization request.')
        break
      case 'expired_token':
        removeFile(PENDING_PATH)
        die('The device code expired before approval. Restart the login flow.')
        break
      default:
        removeFile(PENDING_PATH)
        die(`Device authorization failed: ${JSON.stringify(data)}`)
    }
  }
  removeFile(PENDING_PATH)
  die('The device code expired before approval. Restart the login flow.')
}

function cmdLogout() {
  removeFile(CRED_PATH)
  removeFile(PENDING_PATH)
  console.log(JSON.stringify({ logged_out: true }))
}

async function cmdApi(argv) {
  const [method, path] = argv
  if (!method || !path?.startsWith('/')) {
    die('Usage: oddsbot.mjs api <METHOD> </path> [--json \'<body>\']')
  }
  const jsonFlagIndex = argv.indexOf('--json')
  let body
  if (jsonFlagIndex !== -1) {
    try {
      body = JSON.parse(argv[jsonFlagIndex + 1])
    } catch {
      die('--json value is not valid JSON')
    }
  }
  const response = await apiFetch(method.toUpperCase(), path, body)
  const text = await response.text()
  console.log(text)
  process.exit(response.ok ? 0 : 1)
}

function flagValue(argv, flag) {
  const index = argv.indexOf(flag)
  return index !== -1 ? argv[index + 1] : undefined
}

async function cmdMarkets(argv) {
  const words = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit' || argv[i] === '--cursor' || argv[i] === '--sort') {
      i++ // skip the flag's value
      continue
    }
    words.push(argv[i])
  }
  const params = new URLSearchParams()
  if (words.length > 0) params.set('query', words.join(' '))
  const limit = flagValue(argv, '--limit')
  if (limit) params.set('limit', limit)
  const cursor = flagValue(argv, '--cursor')
  if (cursor) params.set('cursor', cursor)
  const sort = flagValue(argv, '--sort')
  if (sort) params.set('sort', sort)
  const suffix = params.size > 0 ? `?${params}` : ''
  return cmdApi(['GET', `/api/v1/polymarket/markets${suffix}`])
}

// `market <id>`: one market in full, with LIVE order-book quotes per
// outcome. The id is the `id` from a markets listing (a slug or condition id
// also works); the server never falls back to a search, so a typo is a 404,
// not a different market.
function cmdMarket(argv) {
  const id = argv[0]
  if (!id || id.startsWith('-')) {
    die(
      'Usage: oddsbot.mjs market <id>\n' +
        'The id is the `id` field from `markets` output (a market slug or a\n' +
        '0x… condition id also works).',
    )
  }
  return cmdApi(['GET', `/api/v1/polymarket/markets/${encodeURIComponent(id)}`])
}

// `book <token_id>`: order-book depth for ONE outcome token — the resting
// levels a limit order would actually match against. Output is JSON on
// stdout like every command; --json is accepted for uniformity.
function cmdBook(argv) {
  const words = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--depth') {
      i++ // skip the flag's value
      continue
    }
    if (argv[i] === '--json') continue
    words.push(argv[i])
  }
  const tokenId = words[0]
  if (!/^\d+$/.test(tokenId ?? '')) {
    die(
      'Usage: oddsbot.mjs book <token_id> [--depth N] [--json]\n' +
        'The token_id is the numeric `token_id` from `market <id>` output.',
    )
  }
  const depth = flagValue(argv, '--depth')
  const suffix = depth ? `?depth=${encodeURIComponent(depth)}` : ''
  return cmdApi(['GET', `/api/v1/polymarket/book/${tokenId}${suffix}`])
}

// `order <token_id> buy|sell <size>@<price>`: places a LIMIT order.
// `order <token_id> buy|sell <size>@market [--max-slippage <bps>]`: the
// server prices from the live book and places a marketable limit (FAK) at
// the worst price within the slippage bound — or refuses if the book cannot
// cover the size within it. The server enforces the user's spend limits; a
// refused order must never be retried in smaller pieces (see SKILL.md
// safety contract).
async function cmdOrder(argv) {
  const words = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--intent' || argv[i] === '--max-slippage') {
      i++ // skip the flag's value
      continue
    }
    if (argv[i] === '--wait' && /^\d+$/.test(argv[i + 1] ?? '')) {
      i++ // optional explicit timeout in ms
      continue
    }
    if (argv[i] === '--post-only' || argv[i] === '--wait') continue
    words.push(argv[i])
  }
  const [tokenId, side, sizeAtPrice] = words
  const usage =
    'Usage: oddsbot.mjs order <token_id> buy|sell <size>@<price> [--post-only] [--intent ID] [--wait [ms]]\n' +
    '       oddsbot.mjs order <token_id> buy|sell <size>@market [--max-slippage <bps>] [--intent ID] [--wait [ms]]\n' +
    'Examples: order 1234567890 buy 5@0.35   (limit: 5 shares at $0.35 each)\n' +
    '          order 1234567890 buy 5@market --max-slippage 50\n' +
    '          (server-priced from the live book, at most 0.5% above the touch)'
  const limitMatch = /^(\d*\.?\d+)@(0?\.\d+)$/.exec(sizeAtPrice ?? '')
  const marketMatch = /^(\d*\.?\d+)@market$/.exec(sizeAtPrice ?? '')
  if (
    !/^\d+$/.test(tokenId ?? '') ||
    !['buy', 'sell'].includes(side) ||
    (!limitMatch && !marketMatch)
  ) {
    die(usage)
  }
  const intentId = flagValue(argv, '--intent') ?? crypto.randomUUID()
  // --wait [ms]: block until the immediate fills settle on-chain (default
  // 30s, max 60s) and report `settlement`. A timeout never un-places the
  // order — it just means "poll order-status".
  let waitForFill = {}
  if (argv.includes('--wait')) {
    const explicit = flagValue(argv, '--wait')
    const ms = /^\d+$/.test(explicit ?? '') ? Number(explicit) : 30000
    if (ms < 1 || ms > 60000) die('--wait takes a timeout in milliseconds, 1-60000 (default 30000)')
    waitForFill = { wait_for_fill_ms: ms }
  }
  if (marketMatch) {
    if (argv.includes('--post-only')) {
      die('--post-only cannot be combined with @market (market orders exist to match immediately)')
    }
    const maxSlippage = flagValue(argv, '--max-slippage')
    if (maxSlippage !== undefined && !/^\d+$/.test(maxSlippage)) {
      die('--max-slippage takes whole basis points, e.g. --max-slippage 50 for 0.5%')
    }
    return cmdApi([
      'POST',
      '/api/v1/polymarket/orders',
      '--json',
      JSON.stringify({
        type: 'market',
        intent_id: intentId,
        token_id: tokenId,
        side,
        size: Number(marketMatch[1]),
        ...(maxSlippage !== undefined
          ? { max_slippage_bps: Number(maxSlippage) }
          : {}),
        ...waitForFill,
      }),
    ])
  }
  return cmdApi([
    'POST',
    '/api/v1/polymarket/orders',
    '--json',
    JSON.stringify({
      intent_id: intentId,
      token_id: tokenId,
      side,
      size: Number(limitMatch[1]),
      price: Number(limitMatch[2]),
      post_only: argv.includes('--post-only'),
      ...waitForFill,
    }),
  ])
}

function cmdCancel(argv) {
  const usage =
    'Usage: oddsbot.mjs cancel <order_id>                (order ids start with 0x)\n' +
    '       oddsbot.mjs cancel --all                     (every open order)\n' +
    '       oddsbot.mjs cancel --all --token <token_id>  (one outcome token)\n' +
    '       oddsbot.mjs cancel --all --market <condition_id>  (one market, 0x… condition id)'
  if (argv.includes('--all')) {
    const token = flagValue(argv, '--token')
    const market = flagValue(argv, '--market')
    if (token !== undefined && !/^\d+$/.test(token)) die(usage)
    if (market !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(market)) die(usage)
    if (token !== undefined && market !== undefined) die('--token and --market are mutually exclusive')
    const query = token !== undefined ? `?token_id=${token}` : market !== undefined ? `?condition_id=${market}` : ''
    return cmdApi(['DELETE', `/api/v1/polymarket/orders${query}`])
  }
  const orderId = argv[0]
  if (!orderId?.startsWith('0x')) {
    die(usage)
  }
  return cmdApi(['DELETE', `/api/v1/polymarket/orders/${orderId}`])
}

function cmdOrderStatus(argv) {
  const orderId = argv[0]
  if (!orderId?.startsWith('0x')) {
    die('Usage: oddsbot.mjs order-status <order_id>   (order ids start with 0x)')
  }
  return cmdApi(['GET', `/api/v1/polymarket/orders/${orderId}`])
}

// Dead-man's switch. `heartbeat [--ttl <sec>]` arms or renews a lease the
// server keeps alive toward the Polymarket CLOB; if the lease lapses, ALL of
// the user's open orders are canceled. `heartbeat --status` reads it;
// `heartbeat --off` disarms by canceling everything now.
function cmdHeartbeat(argv) {
  if (argv.includes('--status')) {
    return cmdApi(['GET', '/api/v1/polymarket/heartbeat'])
  }
  if (argv.includes('--off')) {
    return cmdApi(['DELETE', '/api/v1/polymarket/heartbeat'])
  }
  const ttl = flagValue(argv, '--ttl')
  if (ttl !== undefined && !/^\d+$/.test(ttl)) {
    die('Usage: oddsbot.mjs heartbeat [--ttl <seconds>] | --status | --off')
  }
  return cmdApi([
    'POST',
    '/api/v1/polymarket/heartbeat',
    '--json',
    JSON.stringify(ttl !== undefined ? { ttl_sec: Number(ttl) } : {}),
  ])
}

const HELP = `OddsBot agent CLI

Usage: oddsbot.mjs <command>

Commands:
  status                        Print auth state (exit 42 if not authenticated)
  login                         Start device authorization and wait for approval
  login --no-poll               Start device authorization, print URL + code, exit
  login --wait                  Poll until the pending authorization is approved
  login --trade                 Include the polymarket:trade scope in the request
                                (combinable with --no-poll; needs the user's
                                explicit agreement FIRST — see SKILL.md)
  logout                        Delete local credentials
  api <METHOD> </path> [--json '<body>']
                                Authenticated API call, response body to stdout
  balance                       Real pUSD balance of the user's Polymarket wallet
  markets [query] [--limit N] [--cursor C] [--sort trending|newest|all]
                                Search markets, or list them sorted by 24h
                                volume (default), launch date, or unsorted
  market <id>                   One market in detail: metadata plus live
                                order-book quotes (bid/ask/mid/spread, tick
                                size, min size, fees, neg_risk) per outcome
  book <token_id> [--depth N] [--json]
                                Order-book depth for one outcome token: top-N
                                bid/ask levels (default 10, max 50) with
                                cumulative USD depth, midpoint, spread, tick
                                size, min size, neg_risk
  positions                     The user's Polymarket positions (read-only)
  order <token_id> buy|sell <size>@<price> [--post-only] [--intent ID]
                                Place a real-money limit order (requires the
                                polymarket:trade scope and user confirmation)
  order <token_id> buy|sell <size>@market [--max-slippage <bps>] [--intent ID]
                                Market order: the server prices it from the
                                live book and places a marketable limit (FAK)
                                at the worst price within the slippage bound
                                (default 100 bps = 1%, max 1000). Refused —
                                never clamped — if the book cannot cover the
                                size within the bound.
                                Add --wait [ms] to either form to block (default
                                30s, max 60s) until the immediate fills settle
                                on-chain; the response then carries
                                "settlement" with the tx hashes. A timeout
                                never un-places the order.
  orders                        The user's open orders
  order-status <order_id>       One order's live state: status, size matched /
                                remaining, trade ids — poll this instead of
                                the whole list
  cancel <order_id>             Cancel an open order
  cancel --all [--token <id> | --market <condition_id>]
                                Cancel every open order, or only those on one
                                outcome token / one market
  heartbeat [--ttl <sec>]       Arm or renew the dead-man's switch (default 60s,
                                10-900). While armed, OddsBot heartbeats the
                                CLOB for you; if you stop renewing before
                                expiry, ALL the user's open orders are
                                canceled. Renew well inside the TTL.
  heartbeat --status            Lease state (armed, seconds_left, last end)
  heartbeat --off               Disarm = cancel all open orders NOW
  trades                        The user's trade history (fills)

Environment:
  ODDSBOT_API_URL              API base URL (default ${DEFAULT_API_BASE};
                                use http://localhost:3000 for local dev)
  ODDSBOT_HARNESS              Override the detected harness name (this run:
                                ${HARNESS})

Credentials are stored per harness in ~/.oddsbot/credentials.<harness>.json
(0600) — each harness the skill runs in is a separate OddsBot agent with its
own name and grant. Logout only clears local state; server-side revocation is
managed in the OddsBot web app.`

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  switch (command) {
    case 'status':
      return cmdStatus()
    case 'login': {
      const withTrade = rest.includes('--trade')
      if (rest.includes('--no-poll')) return cmdLoginStart(withTrade)
      if (rest.includes('--wait')) return cmdLoginWait()
      await cmdLoginStart(withTrade)
      return cmdLoginWait()
    }
    case 'logout':
      return cmdLogout()
    case 'api':
      return cmdApi(rest)
    case 'balance':
      return cmdApi(['GET', '/api/v1/wallet/balance'])
    case 'markets':
      return cmdMarkets(rest)
    case 'market':
      return cmdMarket(rest)
    case 'book':
      return cmdBook(rest)
    case 'positions':
      return cmdApi(['GET', '/api/v1/polymarket/positions'])
    case 'order':
      return cmdOrder(rest)
    case 'orders':
      return cmdApi(['GET', '/api/v1/polymarket/orders'])
    case 'order-status':
      return cmdOrderStatus(rest)
    case 'cancel':
      return cmdCancel(rest)
    case 'heartbeat':
      return cmdHeartbeat(rest)
    case 'trades':
      return cmdApi(['GET', '/api/v1/polymarket/trades'])
    case 'help':
    case '--help':
    case undefined:
      console.log(HELP)
      return
    default:
      die(`Unknown command: ${command}\n\n${HELP}`)
  }
}

main().catch((error) => die(String(error?.stack ?? error)))
