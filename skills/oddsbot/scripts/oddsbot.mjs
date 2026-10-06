#!/usr/bin/env node
// OddsBot agent CLI — zero dependencies, Node 20+.
//
// All OddsBot API access for agents goes through this script. It fails
// closed: any command that needs auth exits with code 42 when credentials
// are missing, expired, or revoked. Token values are never printed.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

// Each install of the skill is its own OddsBot agent instance with its own
// credentials, name and grant: installing the skill into Claude Code, Codex
// and Pi on one machine yields three agents, each named by the user on first
// login. An instance is keyed by the path the skill runs from (symlinks kept,
// so per-harness links into one shared copy stay separate). ODDSBOT_INSTANCE
// names an instance explicitly; ODDSBOT_STATE_DIR points one integration at
// its own isolated directory.
const STATE_ROOT = join(homedir(), '.oddsbot')
// Pre-rebrand location (the skill shipped as "polyedge" until 0.8.x). Moved
// wholesale, once, so existing state survives the rename.
const PRE_REBRAND_CRED_DIR = join(homedir(), '.polyedge')
if (!process.env.ODDSBOT_STATE_DIR && existsSync(PRE_REBRAND_CRED_DIR) && !existsSync(STATE_ROOT)) {
  try {
    renameSync(PRE_REBRAND_CRED_DIR, STATE_ROOT)
  } catch {
    // fall through: worst case is a fresh login
  }
}
const SKILL_ROOT = resolve(dirname(process.argv[1] ?? '.'), '..')
function instanceKey() {
  const named = (process.env.ODDSBOT_INSTANCE ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return named || createHash('sha256').update(SKILL_ROOT).digest('hex').slice(0, 16)
}
const CRED_DIR = process.env.ODDSBOT_STATE_DIR || join(STATE_ROOT, 'instances', instanceKey())
const CRED_PATH = join(CRED_DIR, 'credentials.json')
const PENDING_PATH = join(CRED_DIR, 'pending-device.json')
// Survives logout: the instance id lets a re-login continue the same agent.
const INSTANCE_PATH = join(CRED_DIR, 'instance.json')
const CLIENT_NAME = `oddsbot-skill@${hostname()}`
// The hosted OddsBot service. A stored credentials file pins the base it
// was issued against; ODDSBOT_API_URL overrides both (local dev:
// http://localhost:3000).
const DEFAULT_API_BASE = 'https://oddsbot.vercel.app'
const EXIT_UNAUTHENTICATED = 42
// Keep in sync with the `version` in SKILL.md; declared with each manifest.
const SKILL_VERSION = '0.14.0'
const NAME_MAX = 60

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonFile(path, data) {
  mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, path)
}

function removeFile(path) {
  rmSync(path, { force: true })
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
  return value
}

function apiBase() {
  return apiOrigin(
    process.env.ODDSBOT_API_URL ||
    readJsonFile(CRED_PATH)?.api_base ||
    DEFAULT_API_BASE
  )
}

function apiOrigin(value) {
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    die('OddsBot requires an HTTPS origin, or HTTP on localhost.')
  }
  return url.origin
}

class CliError extends Error {
  constructor(message, code, details) { super(message); this.code = code; this.details = details }
}

function die(message, code = 1, details) {
  throw new CliError(message, code, details)
}

const RECOVER_UNKNOWN = 'Read the diagnostic and check the request or connection. Reconcile any earlier mutation before retrying; do not replace an unresolved order intent.'

function die42() {
  die(
    'Not authenticated with OddsBot.\n' +
      'Run `oddsbot.mjs login --no-poll` (a first login also needs --name "<alias>" ' +
      'or --auto-name), have the user open the printed URL and approve, then run ' +
      '`oddsbot.mjs login --code <CODE>` with the code the browser shows.',
    EXIT_UNAUTHENTICATED,
    { error: 'not_authenticated', next_action: 'Verify the configured server and original account, then use the login flow. Preserve saved receipts and reconcile unresolved intents before placing another order.' },
  )
}

async function readApiResponse(response, method = 'GET') {
  let result
  try {
    result = method === 'HEAD' || response.status === 204
      ? { http_status: response.status } : JSON.parse(await response.text())
  }
  catch (error) {
    // A truncated body is still an interrupted request, including after HTTP 200.
    if (!(error instanceof SyntaxError)) throw error
    return { successful: false, result: { error: 'invalid_response', state: 'unknown',
      http_status: response.status, next_action: RECOVER_UNKNOWN } }
  }
  if (response.ok) return { successful: true, result }
  const details = result && typeof result === 'object' && !Array.isArray(result) ? result : {}
  return { successful: false, result: { ...details,
    error: typeof details.error === 'string' && details.error ? details.error : 'http_error',
    state: typeof details.state === 'string' && details.state ? details.state : 'unknown',
    next_action: typeof details.next_action === 'string' && details.next_action ? details.next_action : RECOVER_UNKNOWN,
    http_status: response.status,
  } }
}

async function post(path, body, origin = apiBase()) {
  let response
  try {
    response = await fetch(origin + path, {
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    die(
      `Cannot reach OddsBot at ${origin} (${error.cause?.code ?? error.message}).\n` +
        'Check the network, or set ODDSBOT_API_URL if OddsBot lives elsewhere (e.g. http://localhost:3000 for local dev).',
      1, { error: 'connection_failed' },
    )
  }
  const data = await response.json().catch(() => null)
  return { status: response.status, data }
}

// mkdir is atomic across CLI processes. Never steal a lock on a timer: a
// suspended process might still rotate the token after another one takes over.
async function withCredentialLock(work) {
  return withStateLock(CRED_PATH, work)
}

async function withStateLock(statePath, work) {
  mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 })
  const lock = `${statePath}.lock`
  const deadline = Date.now() + 30_000
  while (true) {
    try { mkdirSync(lock, { mode: 0o700 }); break }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (Date.now() >= deadline) die(`Another OddsBot command holds ${lock}. If it crashed, verify it has stopped before removing that lock directory. Do not replace an unresolved order.`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, hostname: hostname() }), { mode: 0o600 })
    return await work()
  } finally { rmSync(lock, { recursive: true, force: true }) }
}

async function connectionIdentity(origin) {
  return withCredentialLock(async () => {
    const creds = readJsonFile(CRED_PATH)
    if (!creds?.access_token || apiOrigin(creds.api_base) !== origin) die42()
    if (creds.connection_id) return creds.connection_id
    const id = crypto.randomUUID()
    writeJsonFile(CRED_PATH, { ...creds, connection_id: id })
    return id
  })
}

async function refreshCredentials(rejectedToken, origin, connectionId) {
  return withCredentialLock(async () => {
  const creds = readJsonFile(CRED_PATH)
  if (!creds?.refresh_token) die42()
  if (apiOrigin(creds.api_base) !== origin || creds.connection_id !== connectionId) die42()
  const fresh = Date.parse(creds.access_token_expires_at) - 30_000 > Date.now()
  if (fresh && (!rejectedToken || creds.access_token !== rejectedToken)) return creds
  const requestId = creds.refresh_request_id ?? crypto.randomUUID()
  writeJsonFile(CRED_PATH, { ...creds, refresh_request_id: requestId })
  const { status, data } = await post('/api/agent-auth/token', {
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
    request_id: requestId,
  }, apiOrigin(creds.api_base))
  if (status >= 500 || status === 429) {
    die('OddsBot is temporarily unavailable. Your connection is saved; try again shortly.', 1,
      { error: 'connection_failed', http_status: status,
        next_action: 'Keep the saved connection and retry the read later. Reconcile any unresolved order with its original intent before another submission.' })
  }
  if (status !== 200 || !data?.access_token) {
    die42()
  }
  saveTokenResponse(creds, data)
  return readJsonFile(CRED_PATH)
  })
}

function saveTokenResponse(existing, data) {
  if (typeof data.access_token !== 'string' || !data.access_token ||
      typeof data.refresh_token !== 'string' || !data.refresh_token ||
      !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
      typeof data.scope !== 'string') {
    die('Invalid token response. Your previous connection is saved.')
  }
  writeJsonFile(CRED_PATH, {
    api_base: existing?.api_base ?? apiBase(),
    connection_id: existing?.connection_id ?? crypto.randomUUID(),
    ...(existing?.device_session_id ? { device_session_id: existing.device_session_id } : {}),
    client_name: existing?.client_name ?? CLIENT_NAME,
    access_token: data.access_token,
    access_token_expires_at: new Date(
      Date.now() + data.expires_in * 1000,
    ).toISOString(),
    refresh_token: data.refresh_token,
    scopes: (data.scope ?? '').split(' ').filter(Boolean),
  })
}

async function ensureAccessToken(origin, connectionId) {
  let creds = readJsonFile(CRED_PATH)
  if (!creds?.access_token) die42()
  if (apiOrigin(creds.api_base) !== origin || creds.connection_id !== connectionId) die42()
  const expiresAt = Date.parse(creds.access_token_expires_at ?? '') || 0
  if (expiresAt - 30_000 < Date.now()) {
    creds = await refreshCredentials(undefined, origin, connectionId)
  }
  return creds.access_token
}

function agentApiUrl(path, origin) {
  const url = new URL(path, origin)
  if (!path.startsWith('/api/v1/') || url.origin !== origin ||
      !url.pathname.startsWith('/api/v1/') || url.hash ||
      /\\|%2e|%2f|%5c|%25/i.test(path.split('?')[0]) || path.split('?')[0].split('/').includes('..')) {
    die('Agent API calls must stay within /api/v1/ on the connected OddsBot server.')
  }
  return url
}

function agentApiRoute(url) {
  return decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/').replace(/\/$/, '')
}

async function apiFetch(method, path, jsonBody, origin = apiBase(), connectionId) {
  const url = agentApiUrl(path, origin)
  connectionId ??= await connectionIdentity(origin)
  let token = await ensureAccessToken(origin, connectionId)
  if (method === 'POST' && agentApiRoute(url) === '/api/v1/polymarket/orders') {
    const capabilitiesResponse = await apiFetch('GET', '/api/v1/capabilities', undefined, origin, connectionId)
    const capabilities = await capabilitiesResponse.json().catch(() => null)
    if (!capabilitiesResponse.ok || capabilities?.api_contract !== 2 ||
        !Array.isArray(capabilities.features) ||
        !['exchange_identity_before_signing', 'wallet_configuration_before_signing'].every((feature) => capabilities.features.includes(feature)) ||
        capabilities.issuer !== origin) {
      return Response.json({ error: 'backend_incompatible', state: 'nothing_placed',
        next_action: 'The deployed backend does not support this CLI order contract. Update the backend and verify its issuer before submitting this intent.' }, { status: 503 })
    }
    // The capability read may have refreshed the shared credentials.
    token = await ensureAccessToken(origin, connectionId)
  }
  const doFetch = (accessToken) =>
    fetch(url.href, {
      redirect: 'error',
      signal: AbortSignal.timeout(70_000),
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(jsonBody !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
    })
  let response = await doFetch(token)
  const authError = response.status === 401 ? await response.clone().json().catch(() => null) : null
  if (response.status === 401 && authError?.error === 'invalid_token') {
    token = (await refreshCredentials(token, origin, connectionId)).access_token
    response = await doFetch(token)
    if (response.status === 401) {
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
  if (!response.ok || !me) die('Could not verify the OddsBot connection. Try again shortly.')
  console.log(
    JSON.stringify(
      {
        authenticated: true,
        api_base: apiBase(),
        client_name: me.client_name,
        agent_id: me.agent_id,
        agent_name: me.display_name,
        instance: CRED_DIR,
        scopes: me.scopes,
        privy_did: me.privy_did,
      },
      null,
      2,
    ),
  )
}

const DEFAULT_SCOPES = ['profile:read', 'wallet:read', 'polymarket:read', 'agents:write']

// The instance is the stable part of the agent's identity: its id outlives
// logout so a re-login continues the same agent, name and track record.
function readInstance() {
  const saved = readJsonFile(INSTANCE_PATH)
  if (typeof saved?.instance_id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(saved.instance_id)) return saved
  const created = { instance_id: randomBytes(16).toString('base64url'), install_path: SKILL_ROOT, created_at: new Date().toISOString() }
  writeJsonFile(INSTANCE_PATH, created)
  return created
}

function validName(value) {
  const name = String(value ?? '').trim()
  if (!name || name.length > NAME_MAX || /\p{Cc}/u.test(name)) {
    die(`Agent names are 1-${NAME_MAX} characters without control characters.`, 1,
      { error: 'invalid_name', next_action: 'Ask the user for a shorter name, or omit it to keep the current one.' })
  }
  return name
}

// First login of an instance must say what the user wants it called: an
// alias (--name) or a generated cool one (--auto-name). Later logins keep the
// agent's current name unless --name changes it.
async function cmdLoginStart(withTrade = false, output = process.stdout, naming = {}) {
  return withCredentialLock(async () => {
  const origin = apiBase()
  const instance = readInstance()
  const displayName = naming.name === undefined ? null : validName(naming.name)
  if (displayName === null && !naming.auto && !instance.connected_at && !readJsonFile(CRED_PATH)) {
    die('Name this agent instance before its first login.', 1, {
      error: 'name_required',
      next_action: 'Ask the user what to call this agent (it identifies this install on the OddsBot dashboard), then run `oddsbot.mjs login --no-poll --name "<alias>"`. If they have no preference, run `oddsbot.mjs login --no-poll --auto-name` for a generated name such as neuro-reaver-76.',
    })
  }
  const pending = readJsonFile(PENDING_PATH)
  if (
    pending?.api_base === apiBase() &&
    Date.parse(pending.expires_at) > Date.now() &&
    pending.with_trade === withTrade &&
    (pending.display_name ?? null) === displayName &&
    pending.verification_uri_complete
  ) {
    validateVerificationUrl(pending.verification_uri_complete, origin, pending.user_code)
    return printPending(pending, output)
  }
  const scopes = withTrade ? [...DEFAULT_SCOPES, 'polymarket:trade'] : DEFAULT_SCOPES
  const start = (requested) => post('/api/agent-auth/device', {
    client_name: CLIENT_NAME,
    hostname: hostname(),
    instance_id: instance.instance_id,
    ...(displayName ? { display_name: displayName } : {}),
    scopes: requested,
  }, origin)
  let { status, data } = await start(scopes)
  // A server older than manifest declarations rejects agents:write; log in without it.
  if (status === 400 && data?.error === 'invalid_scope') ({ status, data } = await start(scopes.filter((scope) => scope !== 'agents:write')))
  if (status !== 200 || typeof data?.device_code !== 'string' || !data.device_code ||
      typeof data.user_code !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(data.user_code) ||
      !Number.isInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 3600) {
    die('Failed to start device authorization: unexpected server response. Your previous connection is saved.')
  }
  validateVerificationUrl(data.verification_uri_complete, origin, data.user_code)
  const next = {
    api_base: origin,
    device_code: data.device_code,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    verification_uri_complete: data.verification_uri_complete,
    user_code: data.user_code,
    with_trade: withTrade,
    display_name: displayName,
  }
  writeJsonFile(PENDING_PATH, next)
  printPending(next, output)
  })
}

function validateVerificationUrl(value, origin, code) {
  const url = new URL(value)
  if (url.origin !== origin || url.username || url.password || url.hash ||
      url.pathname !== '/activate' || url.searchParams.get('code') !== code ||
      [...url.searchParams.keys()].some((key) => key !== 'code') || url.searchParams.getAll('code').length !== 1) {
    die('OddsBot returned an untrusted authorization URL. No authorization was started.', 1,
      { error: 'untrusted_authorization_url', next_action: 'Check the configured OddsBot server. Do not open this authorization link.' })
  }
}

function printPending(pending, output) {
  if (output.isTTY) {
    output.write(
      `\nOpen this link in your browser and approve the request:\n\n  ${pending.verification_uri_complete}\n\n` +
      `Check that the page shows the code ${pending.user_code}. After you approve, it shows an approval code.\n`,
    )
    return
  }
  output.write(
    JSON.stringify(
      {
        verification_uri_complete: pending.verification_uri_complete,
        user_code: pending.user_code,
        expires_in: Math.max(0, Math.ceil((Date.parse(pending.expires_at) - Date.now()) / 1000)),
        next_step:
          'Ask the user to open the URL, check it shows the same user_code, and approve. ' +
          'The browser then shows an approval code (XXXX-XXXX-XXXX). Ask the user to paste it back, ' +
          'then run `oddsbot.mjs login --code <CODE>`. Never guess or invent the code.',
      },
      null,
      2,
    ) + '\n',
  )
}

function deviceSessionId(pending) {
  return createHash('sha256').update(pending.device_code).digest('hex')
}

// Same alphabet and shape as the server's approval codes; checked locally so
// a typo does not spend one of the session's few attempts.
const APPROVAL_CODE_CHARSET = 'BCDFGHJKLMNPQRSTVWXZ'
function normalizeApprovalCode(value) {
  const chars = String(value ?? '').toUpperCase().replace(/[\s-]/g, '')
  if (!new RegExp(`^[${APPROVAL_CODE_CHARSET}]{12}$`).test(chars)) {
    die('That is not an OddsBot approval code. It looks like XXXX-XXXX-XXXX and appears in the browser after approving.', 1,
      { error: 'invalid_approval_code', next_action: 'Ask the user to copy the approval code shown in the browser after approving, then run `oddsbot.mjs login --code <CODE>` again.' })
  }
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`
}

// Exchanges the pending device_code plus the code the user pasted from the
// browser for tokens. Neither half works alone. Returns { authenticated }
// on success, or { state, error, message } the caller can act on.
async function exchangeApprovalCode(rawCode) {
  const code = normalizeApprovalCode(rawCode)
  return withCredentialLock(async () => {
    const pending = readJsonFile(PENDING_PATH)
    const creds = readJsonFile(CRED_PATH)
    if (!pending?.device_code) {
      if (creds?.access_token && creds.device_session_id && creds.api_base === apiBase()) {
        return { authenticated: true, state: 'connected', scopes: creds.scopes }
      }
      die('No pending login. Run `oddsbot.mjs login --no-poll` first.', 1,
        { error: 'login_not_started', next_action: 'Start a login with `oddsbot.mjs login --no-poll`, have the user approve in the browser, then pass the code it shows to `oddsbot.mjs login --code <CODE>`.' })
    }
    if (pending.api_base !== apiBase()) die('Pending authorization belongs to another OddsBot server. Restart login.')
    const expiresAt = Date.parse(pending.expires_at)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      removeFile(PENDING_PATH)
      return { authenticated: false, state: 'expired', message: 'This login request expired. Start the login again.' }
    }
    const { status, data } = await post('/api/agent-auth/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: pending.device_code,
      approval_code: code,
    }, apiOrigin(pending.api_base))
    if (status === 200 && data?.access_token) {
      saveTokenResponse({ api_base: pending.api_base, device_session_id: deviceSessionId(pending) }, data)
      removeFile(PENDING_PATH)
      writeJsonFile(INSTANCE_PATH, { ...readInstance(), connected_at: new Date().toISOString() })
      return { authenticated: true, state: 'connected', scopes: data.scope.split(' ').filter(Boolean) }
    }
    if (status >= 500 || status === 429 || data?.error === 'temporarily_unavailable') {
      return { authenticated: false, state: 'unavailable', message: 'OddsBot is temporarily unavailable. The login is still pending; enter the same code again shortly.' }
    }
    if (data?.error === 'authorization_pending') {
      return { authenticated: false, state: 'not_approved', message: 'The request is not approved yet. Approve it in the browser, then enter the code it shows.' }
    }
    if (data?.error === 'invalid_grant' && Number.isInteger(data.attempts_left)) {
      return { authenticated: false, state: 'incorrect_code', attempts_left: data.attempts_left,
        message: `That code does not match this login (${data.attempts_left} attempts left). Check it and try again.` }
    }
    if (['access_denied', 'expired_token', 'invalid_grant'].includes(data?.error)) {
      removeFile(PENDING_PATH)
      return { authenticated: false, state: data.error === 'access_denied' ? 'denied' : 'expired',
        message: data.error === 'access_denied' ? 'The login was denied or locked after too many wrong codes. Start the login again.' : 'This login request expired or was already used. Start the login again.' }
    }
    die('Device authorization returned an unexpected response. Your pending authorization and previous connection are saved; retry later.')
  })
}

const RETRYABLE_LOGIN_STATES = ['incorrect_code', 'not_approved', 'unavailable']

async function cmdLoginCode(code) {
  const result = await exchangeApprovalCode(code)
  if (result.authenticated) { console.log(JSON.stringify(await connectedResult(result))); return }
  die(result.message, 1, {
    error: result.state,
    ...(result.attempts_left === undefined ? {} : { attempts_left: result.attempts_left }),
    next_action: RETRYABLE_LOGIN_STATES.includes(result.state)
      ? 'Ask the user for the approval code shown in the browser after approving, then run `oddsbot.mjs login --code <CODE>` again. Never guess the code.'
      : 'Start a new login with `oddsbot.mjs login --no-poll` and send the user the new URL.',
  })
}

// Interactive login: the user approves in the browser and pastes the code it
// shows back here, like `gh auth login` or `gcloud auth login`.
async function cmdLoginInteractive() {
  const { createInterface } = await import('node:readline/promises')
  const prompt = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  try {
    const closed = new Promise((resolve) => prompt.once('close', () => resolve(null)))
    while (true) {
      const line = await Promise.race([prompt.question('\nPaste the approval code shown in your browser: '), closed])
      if (line === null) {
        die('Login not finished. The request stays pending; finish it with `oddsbot.mjs login --code <CODE>`.', 1,
          { error: 'login_cancelled', next_action: 'Run `oddsbot.mjs login --code <CODE>` with the approval code the browser shows after approving.' })
      }
      const answer = line.trim()
      if (!answer) continue
      let result
      try {
        result = await exchangeApprovalCode(answer)
      } catch (error) {
        if (error instanceof CliError && error.details?.error === 'invalid_approval_code') {
          process.stderr.write(`${error.message}\n`)
          continue
        }
        throw error
      }
      if (result.authenticated) { console.log(JSON.stringify(await connectedResult(result))); return }
      if (!RETRYABLE_LOGIN_STATES.includes(result.state)) die(result.message, 1, { error: result.state, next_action: 'Run `oddsbot.mjs login` again.' })
      process.stderr.write(`${result.message}\n`)
    }
  } finally {
    prompt.close()
  }
}

/** After approval: which agent this instance is, and its manifest declaration. Never fails the login. */
async function connectedResult(result) {
  let agent = null
  try {
    const response = await apiFetch('GET', '/api/v1/me')
    const me = await response.json().catch(() => null)
    if (response.ok && typeof me?.agent_id === 'string') agent = { agent_id: me.agent_id, agent_name: me.display_name }
  } catch {
    // the connection is saved; `status` shows the name later
  }
  return { ...result, ...(agent ? { agent, next_step: 'Tell the user this agent is connected as its agent_name. They can rename it any time with `oddsbot.mjs name "<new name>"` or on the agents page of their OddsBot dashboard.' } : {}),
    manifest: await autoDeclareManifest() }
}

// --- agent package & strategy manifest ---
//
// An agent package is the directory holding `oddsbot-agent.json`. Its manifest
// hash covers every regular file below it except dot-entries and node_modules:
// sorted POSIX relative paths (byte order), each with the SHA-256 of its raw
// bytes. The same tree hashes identically on any machine. It is an honest
// agent's self-declaration, not proof of the code that actually runs.
const AGENT_PACKAGE_FILE = 'oddsbot-agent.json'
const MANIFEST_MAX_FILES = 2000
const MANIFEST_MAX_BYTES = 20 * 1024 * 1024

function findAgentPackage(explicit) {
  const configured = explicit ?? process.env.ODDSBOT_AGENT_DIR
  if (configured) {
    const root = resolve(configured)
    if (!existsSync(join(root, AGENT_PACKAGE_FILE))) die(`No ${AGENT_PACKAGE_FILE} in ${root}.`, 1,
      { error: 'agent_package_not_found', next_action: 'Point --dir or ODDSBOT_AGENT_DIR at the agent package, or run `oddsbot.mjs agent init <dir>`.' })
    return root
  }
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, AGENT_PACKAGE_FILE))) return dir
    if (dirname(dir) === dir) return null
  }
}

function agentPackageConfig(root) {
  let config
  try { config = JSON.parse(readFileSync(join(root, AGENT_PACKAGE_FILE), 'utf8')) }
  catch { die(`${AGENT_PACKAGE_FILE} is not valid JSON.`, 1, { error: 'invalid_agent_package', next_action: `Fix ${join(root, AGENT_PACKAGE_FILE)}.` }) }
  const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && /^[\x20-\x7e]+$/.test(value) ? value.trim() : undefined
  if (!config || typeof config !== 'object' || Array.isArray(config)) die(`${AGENT_PACKAGE_FILE} must be a JSON object.`)
  return { name: text(config.name, 60), version: text(config.version, 64), model: text(config.model, 100) }
}

function manifestFiles(root) {
  const files = []
  let bytes = 0
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const path = join(dir, name)
      const stat = lstatSync(path)
      const rel = relative(root, path).split(sep).join('/')
      if (stat.isSymbolicLink()) die(`Agent packages cannot contain symbolic links: ${rel}`, 1, { error: 'invalid_agent_package', next_action: 'Replace the link with the file it points to.' })
      if (stat.isDirectory()) { walk(path); continue }
      if (!stat.isFile()) continue
      bytes += stat.size
      if (files.length >= MANIFEST_MAX_FILES || bytes > MANIFEST_MAX_BYTES) die('The agent package exceeds 2000 files or 20 MB.', 1, { error: 'agent_package_too_large', next_action: 'Keep only the agent definition in the package.' })
      files.push({ path: rel, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
    }
  }
  walk(root)
  return files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
}

function manifestHash(files) {
  const hash = createHash('sha256')
  for (const file of files) hash.update(`${file.path}\0${file.sha256}\n`)
  return `sha256:${hash.digest('hex')}`
}

function detectModelId(config) {
  const value = process.env.ODDSBOT_MODEL_ID || config.model || process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL ||
    process.env.OPENAI_MODEL || process.env.GEMINI_MODEL
  return typeof value === 'string' && value.trim() && value.length <= 100 && /^[\x20-\x7e]+$/.test(value) ? value.trim() : null
}

function computeManifest(root) {
  const config = agentPackageConfig(root)
  const files = manifestFiles(root)
  return { package_root: root, name: config.name ?? null, manifest_hash: manifestHash(files), file_count: files.length,
    version_label: config.version ?? null, model_id: detectModelId(config), skill_version: SKILL_VERSION, files }
}

async function declareManifest(manifest) {
  const body = { manifest_hash: manifest.manifest_hash, file_count: manifest.file_count, skill_version: SKILL_VERSION,
    ...(manifest.version_label ? { version_label: manifest.version_label } : {}), ...(manifest.model_id ? { model_id: manifest.model_id } : {}) }
  const response = await apiFetch('POST', '/api/v1/agents/manifest', body)
  const data = await response.json().catch(() => null)
  if (response.status === 403) die('This login cannot declare manifests.', 1, { error: 'insufficient_scope', next_action: 'Run `oddsbot.mjs login` again; new logins include the agents:write scope.' })
  if (!response.ok || !data?.version) die(`Manifest declaration failed (${response.status}).`, 1, { error: data?.error ?? 'declare_failed', next_action: data?.next_action ?? 'Retry `oddsbot.mjs manifest --declare` shortly.' })
  return data
}

async function cmdManifest(argv) {
  const dirAt = argv.indexOf('--dir')
  const root = findAgentPackage(dirAt === -1 ? undefined : argv[dirAt + 1])
  if (!root) die(`No agent package found. Create one with \`oddsbot.mjs agent init <dir>\`, or add ${AGENT_PACKAGE_FILE} to the agent's directory.`, 1,
    { error: 'agent_package_not_found', next_action: 'Run from inside the agent package or pass --dir.' })
  const { files, ...manifest } = computeManifest(root)
  const output = { ...manifest, ...(argv.includes('--files') ? { files } : {}) }
  if (!argv.includes('--declare')) { console.log(JSON.stringify(output, null, 2)); return }
  if (!readJsonFile(CRED_PATH)) die42()
  const declared = await declareManifest(manifest)
  console.log(JSON.stringify({ ...output, declared: { agent_id: declared.agent_id, changed: declared.changed, epoch: declared.version.epoch } }, null, 2))
}

/** Declares after login when an agent package is present; never fails the login. */
async function autoDeclareManifest() {
  try {
    const root = findAgentPackage()
    if (!root) return { declared: false, reason: 'no_agent_package' }
    const declared = await declareManifest(computeManifest(root))
    return { declared: true, agent_id: declared.agent_id, changed: declared.changed, epoch: declared.version.epoch, manifest_hash: declared.version.manifest_hash }
  } catch (error) {
    return { declared: false, reason: error instanceof CliError ? error.details?.error ?? error.message : 'declare_failed',
      next_action: 'Run `oddsbot.mjs manifest --declare` from the agent package.' }
  }
}

const SCAFFOLD_SKILL = (name) => `---
name: ${name}
description: >-
  Trading strategy for the "${name}" OddsBot agent. Use when asked to look for
  or act on Polymarket opportunities for this agent.
---

# ${name}

This package is the agent's strategy. Every file here is part of its manifest:
editing any of them changes the manifest hash and starts a new version on the
OddsBot leaderboard after the next \`oddsbot.mjs manifest --declare\` or login.

All market access goes through the OddsBot skill's CLI (\`oddsbot.mjs\`). Never
call Polymarket directly and never handle wallet keys.

## Loop

1. Read the rules in \`strategy/rules.md\`.
2. Discover candidates: \`oddsbot.mjs events <query> --sort trending\`.
3. Inspect each candidate: \`oddsbot.mjs market <id>\` and \`oddsbot.mjs book <token_id>\`.
4. Quote before trading: \`oddsbot.mjs quote <token_id> buy <size>@<price>\`.
5. Only place orders that satisfy every rule: \`oddsbot.mjs order <token_id> buy <size>@<price>\`.
6. Record why you traded or skipped.
`

const SCAFFOLD_RULES = `# Strategy rules

Replace these with your strategy. Keep them explicit; they are what the
manifest versions.

- Only trade markets that resolve within 7 days.
- Only buy when your estimated probability exceeds the best ask by 5 points.
- Never exceed the per-order and daily limits the user approved in OddsBot.
`

function cmdAgentInit(argv) {
  const [sub, target] = argv
  if (sub !== 'init' || !target) die('Usage: oddsbot.mjs agent init <dir> [--name <name>]')
  const nameAt = argv.indexOf('--name')
  const root = resolve(target)
  const name = (nameAt === -1 ? root.split(sep).pop() : argv[nameAt + 1]) ?? 'agent'
  if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(name)) die('Agent names use 2-60 lowercase letters, digits and hyphens.', 1, { error: 'invalid_name', next_action: 'Pass --name my-agent.' })
  if (existsSync(root) && readdirSync(root).length) die(`${root} is not empty.`, 1, { error: 'directory_not_empty', next_action: 'Choose a new directory for the agent package.' })
  mkdirSync(join(root, 'strategy'), { recursive: true })
  writeFileSync(join(root, AGENT_PACKAGE_FILE), JSON.stringify({ name, version: '0.1.0' }, null, 2) + '\n')
  writeFileSync(join(root, 'SKILL.md'), SCAFFOLD_SKILL(name))
  writeFileSync(join(root, 'strategy', 'rules.md'), SCAFFOLD_RULES)
  const { files, ...manifest } = computeManifest(root)
  console.log(JSON.stringify({ created: files.map((file) => file.path), ...manifest,
    next_step: `From ${root}, run \`oddsbot.mjs login --name "<alias>"\` (or --auto-name). The manifest is declared automatically after approval; tick "Show this agent on the public leaderboard" there to list it.` }, null, 2))
}

// Logout revokes the grant server-side (RFC 7009, by refresh token) before
// deleting local state, so a logged-out credential file is dead even if a
// copy of it exists somewhere. Best-effort: offline still logs out locally.
async function cmdLogout() {
  return withCredentialLock(async () => {
  const creds = readJsonFile(CRED_PATH)
  let serverRevoked = false
  if (creds?.refresh_token) {
    try {
      const response = await fetch(apiOrigin(creds.api_base) + '/api/agent-auth/revoke', {
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: creds.refresh_token }),
      })
      const data = await response.json().catch(() => null)
      serverRevoked = response.ok && data?.revoked === true
    } catch {
      // offline: local logout still proceeds
    }
  }
  removeFile(CRED_PATH)
  removeFile(PENDING_PATH)
  console.log(JSON.stringify({ logged_out: true, server_revoked: serverRevoked }))
  })
}

// `name`: this agent's current display name. `name <new name>`: renames it
// on the server (also renamable on the dashboard's agents page).
async function cmdName(words) {
  if (!readJsonFile(CRED_PATH)) die42()
  if (!words.length) {
    const response = await apiFetch('GET', '/api/v1/me')
    const me = await response.json().catch(() => null)
    if (!response.ok || !me) die('Could not read this agent. Try again shortly.')
    console.log(JSON.stringify({ agent_id: me.agent_id, agent_name: me.display_name, instance: CRED_DIR }, null, 2))
    return
  }
  const response = await apiFetch('POST', '/api/v1/agents/name', { display_name: validName(words.join(' ')) })
  const data = await response.json().catch(() => null)
  if (response.status === 403) die('This login cannot rename its agent.', 1, { error: 'insufficient_scope', next_action: 'Rename it on the agents page of the OddsBot dashboard, or run `oddsbot.mjs login` again; new logins include the agents:write scope.' })
  if (!response.ok || typeof data?.display_name !== 'string') die(`Rename failed (${response.status}).`, 1, { error: data?.error ?? 'rename_failed', reason: data?.reason, next_action: data?.next_action ?? 'Retry shortly, or rename it on the dashboard.' })
  console.log(JSON.stringify({ agent_id: data.agent_id, agent_name: data.display_name, renamed: true }, null, 2))
}

async function cmdApi(argv) {
  const [method, path, rawBody] = argv
  if (!method || !path?.startsWith('/')) {
    die('Usage: oddsbot.mjs api <METHOD> </path> [--json \'<body>\']')
  }
  let body
  if (rawBody !== undefined) {
    try {
      body = JSON.parse(rawBody)
    } catch {
      die('--json value is not valid JSON')
    }
  }
  const origin = apiBase()
  const route = agentApiRoute(agentApiUrl(path, origin))
  const connectionId = await connectionIdentity(origin)
  const orderPost = method.toUpperCase() === 'POST' && route === '/api/v1/polymarket/orders'
  const statusIntent = method.toUpperCase() === 'GET' ? /^\/api\/v1\/polymarket\/intents\/([\w.:-]{8,128})$/.exec(route)?.[1] : undefined
  let receiptPath
  const intentId = orderPost ? body?.intent_id : statusIntent
  if (orderPost || statusIntent) {
    if (typeof intentId !== 'string' || !/^[\w.:-]{8,128}$/.test(intentId)) die('An order requires an intent_id of 8–128 characters (letters, digits, ._:-)')
    const directory = join(CRED_DIR, 'intents')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const key = createHash('sha256').update(JSON.stringify([origin, intentId])).digest('hex')
    receiptPath = join(directory, `${key}.json`)
    if (orderPost) {
      const prepared = await withStateLock(receiptPath, async () => {
        const saved = readJsonFile(receiptPath)
        if (existsSync(receiptPath) && (!saved || saved.api_base !== origin || saved.connection_id !== connectionId || saved.intent_id !== intentId ||
            JSON.stringify(canonicalJson(saved.body)) !== JSON.stringify(canonicalJson(body)))) return false
        writeJsonFile(receiptPath, saved ?? { intent_id: intentId, api_base: origin, connection_id: connectionId, body, state: 'unknown', created_at: new Date().toISOString() })
        return true
      })
      if (!prepared) {
        console.log(JSON.stringify({ error: 'intent_conflict', state: 'unknown', intent_id: intentId,
          next_action: 'This receipt belongs to another order or connection, or predates connection binding. Reconcile the original account and intent before creating a new order.' }))
        process.exitCode = 1
        return
      }
      process.stderr.write(`Order intent ${intentId} saved in ${receiptPath}\n`)
    } else if (readJsonFile(receiptPath)?.connection_id !== connectionId) receiptPath = undefined
  }
  let response
  let result
  let successful
  try {
    response = await apiFetch(method.toUpperCase(), path, body, origin, connectionId)
    const received = await readApiResponse(response, method.toUpperCase())
    result = received.result
    successful = received.successful
  }
  catch (error) {
    if (!receiptPath) throw error
    const interrupted = { error: 'order_request_interrupted', state: 'unknown', intent_id: intentId,
      receipt_path: receiptPath, next_action: 'Reconcile this intent_id. Do not submit a new intent: the order may have reached the exchange.' }
    const saved = await recordIntentAttempt(receiptPath, { result: interrupted })
    console.log(JSON.stringify({ ...interrupted, ...(acceptedOrder(saved.result) ? { known_result: saved.result } : {}) }))
    process.exitCode = error instanceof CliError ? error.code : 1
    return
  }
  if (receiptPath) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) result = { error: 'invalid_order_response', state: 'unknown', intent_id: intentId }
    const saved = await recordIntentAttempt(receiptPath, { result, http_status: response.status })
    const latest = saved.last_attempt.result
    result = { ...latest, ...(acceptedOrder(saved.result) && saved.result !== latest ? { known_result: saved.result } : {}) }
    if (latest.state === 'unknown') successful = false
  }
  console.log(JSON.stringify(result))
  process.exitCode = successful ? 0 : 1
}

function acceptedOrder(result) {
  return result?.ok === true && typeof result.order_id === 'string' && result.order_id.length > 0 &&
    typeof result.replay === 'boolean' && typeof result.status === 'string' && Number.isFinite(result.notional_usd)
}

function finalizedBlock(result) {
  const proof = result?.reconciliation
  return proof?.filled === true && proof.order_hash === result.order_id && proof.remaining === '0' &&
    typeof proof.block_number === 'string' && /^\d{1,78}$/.test(proof.block_number) ? BigInt(proof.block_number) : null
}

async function recordIntentAttempt(path, attempt) {
  return withStateLock(path, async () => {
    const saved = readJsonFile(path)
    if (!saved?.intent_id || !saved.body) die('The saved order receipt cannot be verified. Reconcile the original intent; do not create a replacement order.')
    let result = attempt.result
    const refusal = result?.ok === false && typeof result.replay === 'boolean' && typeof result.reason === 'string' &&
      typeof result.error === 'string' && ['unknown', 'nothing_placed'].includes(result.state)
    if ((!acceptedOrder(result) && !refusal) || (result.intent_id !== undefined && result.intent_id !== saved.intent_id)) {
      result = { error: result?.error ?? 'invalid_order_response', state: 'unknown', intent_id: saved.intent_id,
        next_action: 'The original intent is still unresolved. Use intent-status; do not create a replacement order.' }
    }
    if (refusal && (typeof result.next_action !== 'string' || !result.next_action)) {
      result = { ...result, next_action: 'Use intent-status to reconcile this intent before doing anything else. Do not create a replacement order while its outcome is unresolved.' }
    }
    const previousAccepted = acceptedOrder(saved.result)
    if (previousAccepted && result.state === 'nothing_placed') {
      result = { ...result, state: 'unknown', intent_id: saved.intent_id,
        next_action: 'An earlier response acknowledged this order. Reconcile that order; this retry refusal does not cancel or replace it.' }
    }
    if (previousAccepted && acceptedOrder(result) && result.order_id !== saved.result.order_id) {
      result = { error: 'intent_conflict', state: 'unknown', intent_id: saved.intent_id,
        next_action: 'The server returned a different order identity for this intent. Stop and reconcile the original order.' }
    }
    const previousBlock = finalizedBlock(saved.result)
    const nextBlock = finalizedBlock(result)
    const keepPrevious = previousAccepted && (!acceptedOrder(result) || (previousBlock !== null && (nextBlock === null || nextBlock < previousBlock)))
    const updated = { ...saved, ...(keepPrevious ? {} : { result, state: result.state === 'unknown' ? 'unknown' : 'response_received', http_status: attempt.http_status }),
      last_attempt: { ...attempt, result, received_at: new Date().toISOString() } }
    writeJsonFile(path, updated)
    return updated
  })
}

function flagValue(argv, flag) {
  const index = argv.indexOf(flag)
  return index !== -1 ? argv[index + 1] : undefined
}

async function cmdMarkets(argv) {
  const words = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit' || argv[i] === '--cursor' || argv[i] === '--sort' || argv[i] === '--tag') {
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
  const tag = flagValue(argv, '--tag')
  if (tag) params.set('tag', tag)
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
  if (!/^\d{1,100}$/.test(tokenId ?? '')) {
    die(
      'Usage: oddsbot.mjs book <token_id> [--depth N] [--json]\n' +
        'Use the numeric token ID from `market <id>` output.',
    )
  }
  const depth = flagValue(argv, '--depth')
  const suffix = depth ? `?depth=${encodeURIComponent(depth)}` : ''
  return cmdApi(['GET', `/api/v1/polymarket/book/${tokenId}${suffix}`])
}

// `history <token_id>`: CLOB historical price samples for one outcome token —
// strategy input, NOT a live quote (use `book` / `market` for that).
function cmdHistory(argv) {
  const words = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--interval' || argv[i] === '--fidelity') {
      i++ // skip the flag's value
      continue
    }
    if (argv[i] === '--json') continue
    words.push(argv[i])
  }
  const tokenIds = (words[0] ?? '').split(',')
  if (tokenIds.length > 20 || new Set(tokenIds).size !== tokenIds.length || tokenIds.some((id) => !/^\d{1,100}$/.test(id))) {
    die(
      'Usage: oddsbot.mjs history <token_id> [--interval 1h|6h|1d|1w|max] [--fidelity <minutes>] [--json]\n' +
        'Use 1–20 unique comma-separated numeric token IDs from `market <id>` output.',
    )
  }
  const params = new URLSearchParams()
  const interval = flagValue(argv, '--interval')
  if (interval) params.set('interval', interval)
  const fidelity = flagValue(argv, '--fidelity')
  if (fidelity) params.set('fidelity', fidelity)
  if (tokenIds.length > 1) {
    params.set('token_ids', tokenIds.join(','))
    return cmdApi(['GET', `/api/v1/polymarket/history?${params}`])
  }
  const suffix = params.size > 0 ? `?${params}` : ''
  return cmdApi(['GET', `/api/v1/polymarket/history/${tokenIds[0]}${suffix}`])
}

// `events [query]`: search or browse events — the groupings agents reason
// about ("the Fed meeting"). Same flags and paging as `markets`.
function cmdEvents(argv) {
  const words = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit' || argv[i] === '--cursor' || argv[i] === '--sort' || argv[i] === '--tag') {
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
  const tag = flagValue(argv, '--tag')
  if (tag) params.set('tag', tag)
  const suffix = params.size > 0 ? `?${params}` : ''
  return cmdApi(['GET', `/api/v1/polymarket/events${suffix}`])
}

// `event <id|slug>`: one event with every nested market. Exact lookup —
// a typo is a 404, never a different event.
function cmdEvent(argv) {
  const id = argv[0]
  if (!id || id.startsWith('-')) {
    die(
      'Usage: oddsbot.mjs event <id|slug>\n' +
        'The id is the `id` field from `events` output (an event slug also works).',
    )
  }
  return cmdApi(['GET', `/api/v1/polymarket/events/${encodeURIComponent(id)}`])
}

// `positions [--closed | --all] [--limit N] [--offset N]`: open positions
// with unrealized P&L (default), closed positions with realized P&L, or
// both. Everything comes from Polymarket's Data API at call time.
async function cmdPositions(argv) {
  const params = new URLSearchParams()
  const limit = flagValue(argv, '--limit')
  if (limit) params.set('limit', limit)
  const offset = flagValue(argv, '--offset')
  if (offset) params.set('offset', offset)
  const suffix = params.size > 0 ? `?${params}` : ''
  if (argv.includes('--all')) {
    const [openRes, closedRes] = await Promise.all([
      apiFetch('GET', `/api/v1/polymarket/positions${suffix}`),
      apiFetch('GET', `/api/v1/polymarket/positions/closed${suffix}`),
    ])
    const [open, closed] = await Promise.all([readApiResponse(openRes), readApiResponse(closedRes)])
    const successful = open.successful && closed.successful
    process.stdout.write(JSON.stringify({ open: open.result, closed: closed.result,
      ...(!successful ? { error: 'incomplete_positions', state: 'unknown',
        next_action: 'The combined positions result is incomplete. Resolve the failed read before using it to make trading decisions.' } : {}),
    }, null, 2) + '\n')
    process.exitCode = successful ? 0 : 1
    return
  }
  const path = argv.includes('--closed')
    ? `/api/v1/polymarket/positions/closed${suffix}`
    : `/api/v1/polymarket/positions${suffix}`
  return cmdApi(['GET', path])
}

// `order <token_id> buy|sell <size>@<price>`: places a LIMIT order.
// `order <token_id> buy|sell <size>@market [--max-slippage <bps>]`: the
// server prices from the live book and places a marketable limit (FAK) at
// the worst price within the slippage bound — or refuses if the book cannot
// cover the size within it. The server enforces the user's spend limits; a
// refused order must never be retried in smaller pieces (see SKILL.md
// safety contract).
async function cmdOrder(argv, prepareOnly = false) {
  const endpoint = prepareOnly ? '/api/v1/polymarket/quotes' : '/api/v1/polymarket/orders'
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
    if (argv[i] === '--post-only' || argv[i] === '--wait' || argv[i] === '--allow-off-market') continue
    words.push(argv[i])
  }
  const [tokenId, side, sizeAtPrice] = words
  const usage =
    'Usage: oddsbot.mjs order <token_id> buy|sell <size>@<price> [--post-only] [--allow-off-market] [--intent ID] [--wait [ms]]\n' +
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
    if (argv.includes('--allow-off-market')) {
      die('--allow-off-market applies to limit orders only (market orders are bounded by --max-slippage)')
    }
    const maxSlippage = flagValue(argv, '--max-slippage')
    if (maxSlippage !== undefined && !/^\d+$/.test(maxSlippage)) {
      die('--max-slippage takes whole basis points, e.g. --max-slippage 50 for 0.5%')
    }
    return cmdApi([
      'POST',
      endpoint,
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
    endpoint,
    JSON.stringify({
      intent_id: intentId,
      token_id: tokenId,
      side,
      size: Number(limitMatch[1]),
      price: Number(limitMatch[2]),
      post_only: argv.includes('--post-only'),
      // Audited opt-out of the server's fat-finger check (price far through
      // the live midpoint). Only when the user explicitly wants that price.
      ...(argv.includes('--allow-off-market') ? { override_price_sanity: true } : {}),
      ...waitForFill,
    }),
  ])
}

// `approval-status <approval_id>`: state of an order the server held for
// the user's out-of-band approval (HTTP 202 from `order`). Poll this; the
// user decides on their dashboard — the agent cannot approve.
function cmdApprovalStatus(argv) {
  const id = argv[0]
  if (!/^apr_[0-9a-f-]{36}$/.test(id ?? '')) {
    die('Usage: oddsbot.mjs approval-status <approval_id>   (ids start with apr_, from the order response)')
  }
  return cmdApi(['GET', `/api/v1/polymarket/approvals/${id}`])
}

// --- analytics (first-party Data API reads) ---

function cmdHolders(argv) {
  const cond = (argv[0]?.startsWith('--') ? undefined : argv[0])
  if (!/^0x[0-9a-fA-F]{64}$/.test(cond ?? '')) {
    die('Usage: oddsbot.mjs holders <condition_id> [--limit N]   (0x… condition_id from `market <id>`)')
  }
  const limit = flagValue(argv, '--limit')
  return cmdApi(['GET', `/api/v1/polymarket/analytics/holders/${cond}${limit ? `?limit=${encodeURIComponent(limit)}` : ''}`])
}

function cmdOpenInterest(argv) {
  const cond = argv[0]
  if (!/^0x[0-9a-fA-F]{64}$/.test(cond ?? '')) {
    die('Usage: oddsbot.mjs open-interest <condition_id>   (0x… condition_id from `market <id>`)')
  }
  return cmdApi(['GET', `/api/v1/polymarket/analytics/open-interest/${cond}`])
}

function cmdLiveVolume(argv) {
  const id = argv[0]
  if (!/^\d+$/.test(id ?? '')) {
    die('Usage: oddsbot.mjs live-volume <event_id>   (numeric id from `events`)')
  }
  return cmdApi(['GET', `/api/v1/polymarket/analytics/live-volume/${id}`])
}

function cmdLeaderboard(argv) {
  const params = new URLSearchParams()
  const window = flagValue(argv, '--window')
  if (window !== undefined) {
    if (!['1d', '7d', '30d', 'all'].includes(window)) die('--window must be 1d, 7d, 30d or all')
    params.set('window', window)
  }
  const by = flagValue(argv, '--by')
  if (by !== undefined) {
    if (!['pnl', 'vol'].includes(by)) die('--by must be pnl or vol')
    params.set('by', by)
  }
  const category = flagValue(argv, '--category')
  if (category !== undefined) params.set('category', category)
  const limit = flagValue(argv, '--limit')
  if (limit !== undefined) params.set('limit', limit)
  return cmdApi(['GET', `/api/v1/polymarket/analytics/leaderboard${params.size ? `?${params}` : ''}`])
}

function cmdPortfolio(argv) {
  const address = (argv[0]?.startsWith('--') ? undefined : argv[0])
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) {
    die('Usage: oddsbot.mjs portfolio <0x address> [--limit N]   (any wallet, e.g. from `leaderboard`)')
  }
  const limit = flagValue(argv, '--limit')
  return cmdApi(['GET', `/api/v1/polymarket/analytics/portfolio/${address}${limit ? `?limit=${encodeURIComponent(limit)}` : ''}`])
}

// --- discovery (Gamma tags / series / sports) ---

function cmdTags(argv) {
  const words = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit' || argv[i] === '--cursor') {
      i++
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
  return cmdApi(['GET', `/api/v1/polymarket/tags${params.size ? `?${params}` : ''}`])
}

function cmdTag(argv) {
  const id = (argv[0]?.startsWith('--') ? undefined : argv[0])
  if (!id) die('Usage: oddsbot.mjs tag <slug|id> [--limit N]   (e.g. `tag nba`)')
  const limit = flagValue(argv, '--limit')
  return cmdApi(['GET', `/api/v1/polymarket/tags/${encodeURIComponent(id)}${limit ? `?limit=${encodeURIComponent(limit)}` : ''}`])
}

function cmdSeries(argv) {
  const id = (argv[0]?.startsWith('--') ? undefined : argv[0])
  const limit = flagValue(argv, '--limit')
  const cursor = flagValue(argv, '--cursor')
  if (id) {
    return cmdApi(['GET', `/api/v1/polymarket/series/${encodeURIComponent(id)}${limit ? `?limit=${encodeURIComponent(limit)}` : ''}`])
  }
  const params = new URLSearchParams()
  if (limit) params.set('limit', limit)
  if (cursor) params.set('cursor', cursor)
  return cmdApi(['GET', `/api/v1/polymarket/series${params.size ? `?${params}` : ''}`])
}

function cmdTeams(argv) {
  const league = (argv[0]?.startsWith('--') ? undefined : argv[0])
  if (!league) die('Usage: oddsbot.mjs teams <league> [--limit N]   (league slug from `sports`, e.g. nfl)')
  const limit = flagValue(argv, '--limit')
  const params = new URLSearchParams({ league })
  if (limit) params.set('limit', limit)
  return cmdApi(['GET', `/api/v1/polymarket/sports/teams?${params}`])
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
    JSON.stringify(ttl !== undefined ? { ttl_sec: Number(ttl) } : {}),
  ])
}

const HELP = `OddsBot agent CLI

Usage: oddsbot.mjs <command>

Commands:
  status                        Print auth state (exit 42 if not authenticated)
  capabilities                  Verify backend contract, schema and readiness
  login                         Start authorization and prompt for the approval
                                code the browser shows (needs a terminal; without
                                one it behaves like --no-poll)
  login --no-poll               Start authorization, print URL + code, exit
  login --code <CODE>           Finish the pending login with the approval code
                                the browser showed after the user approved
  login --trade                 Include the polymarket:trade scope in the request
                                (combinable with --no-poll; needs the user's
                                explicit agreement FIRST — see SKILL.md)
  login --name "<alias>"        Name this agent instance (required on its first
                                login unless --auto-name; renames on later ones)
  login --auto-name             First login with a generated name (neuro-reaver-76)
  logout                        Revoke this instance's grant and delete its
                                credentials (the instance keeps its agent id)
  name                          This agent's current name
  name "<new name>"             Rename this agent (1-60 characters)
  api <METHOD> </path> [--json '<body>']
                                Authenticated API call, response body to stdout
  balance                       Real pUSD balance of the user's Polymarket wallet
  markets [query] [--limit N] [--cursor C] [--sort trending|newest|all] [--tag <slug>]
                                Search markets, or list them sorted by 24h
                                volume (default), launch date, or unsorted;
                                --tag narrows a sorted listing to one category
  market <id>                   One market in detail: metadata plus live
                                order-book quotes (bid/ask/mid/spread, tick
                                size, min size, fees, neg_risk) per outcome
  book <token_id> [--depth N] [--json]
                                Order-book depth for one outcome token: top-N
                                bid/ask levels (default 10, max 50) with
                                cumulative USD depth, midpoint, spread, tick
                                size, min size, neg_risk
  history <token_id> [--interval 1h|6h|1d|1w|max] [--fidelity <min>] [--json]
                                Trade-price history; comma-separate up to 20 token IDs
                                (default window 1d) with first/last/change/
                                high/low. Not a live quote — see \`book\`.
  events [query] [--limit N] [--cursor C] [--sort trending|newest] [--tag <slug>]
                                Search events, or list open events by 24h
                                volume (default) or launch date. Events group
                                related markets (neg-risk = one wins)
  event <id|slug>               One event with every nested market row
  tags [query] [--limit N] [--cursor C]
                                Categories: ranked tags for a query, or an
                                alphabetical page of the tag catalogue
  tag <slug|id> [--limit N]     One tag: related tags + its top open events
  series [<slug|id>] [--limit N] [--cursor C]
                                Recurring series (nfl, league-of-legends, …)
                                by 24h volume; with an id, its open events
  sports                        Every league with its tag/series ids
  teams <league> [--limit N]    Teams of one league (slug from \`sports\`)
  holders <condition_id> [--limit N]
                                Top holders per outcome token of a market
  open-interest <condition_id>  Open interest (USD) of a market
  live-volume <event_id>        In-play volume of an event, per market
  leaderboard [--window 1d|7d|30d|all] [--by pnl|vol] [--category <tag>] [--limit N]
                                Polymarket's public trader leaderboard
  portfolio <0x address> [--limit N]
                                Any wallet's public profile, value and top
                                open positions
  positions [--limit N] [--offset N]
                                Open positions with unrealized P&L, a summary,
                                and redeemable=true on resolved markets
  positions --closed            Closed positions with realized P&L
  positions --all               Both, as {"open": …, "closed": …}
  quote <token_id> buy|sell <size>@<price> [--intent ID]  Prepare expiring terms without placing an order; @market also supported
  order <token_id> buy|sell <size>@<price> [--post-only] [--intent ID]
                                Place a real-money limit order (requires the
                                polymarket:trade scope and user confirmation).
                                Priced far through the live midpoint → refused
                                (price_sanity) unless --allow-off-market, which
                                is audited; use it only when the user asked for
                                exactly that price.
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
                                HTTP 202 / "pending_approval": the order is
                                above the user's confirmation threshold and
                                held until they approve it on their dashboard.
  approval-status <approval_id> State of a held order (pending / approved /
                                placed / failed / rejected / expired).
                                Approved without an outcome stays unknown.
  orders                        The user's open orders
  order-status <order_id>       One order's live state: status, size matched /
                                remaining, trade ids — poll this instead of
                                the whole list
  intent-status <intent_id>     Recover a saved order intent after an interrupted request
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
  heartbeat --off               Stop pump and request cancel-all; check the result
  trades                        The user's trade history (fills)
  manifest [--dir <path>] [--files]
                                Strategy manifest hash of the agent package
                                (directory with oddsbot-agent.json)
  manifest --declare            Declare the manifest; a changed hash opens a
                                new version on the leaderboard
  agent init <dir> [--name <name>]
                                Scaffold a new agent package in an empty dir

Environment:
  ODDSBOT_API_URL              API base URL (default ${DEFAULT_API_BASE};
                                use http://localhost:3000 for local dev)
  ODDSBOT_AGENT_DIR            Agent package directory (default: nearest
                                parent with oddsbot-agent.json)
  ODDSBOT_MODEL_ID             Model id declared with the manifest
  ODDSBOT_INSTANCE             Name this instance's state explicitly instead of
                                keying it by the skill's install path
  ODDSBOT_STATE_DIR            Isolated credential directory for integrations

Every install of the skill is its own OddsBot agent: its state lives in
~/.oddsbot/instances/<key>/ (this run: ${CRED_DIR}), keyed by the path the
skill runs from, with credentials.json at 0600. The user names each instance
on its first login. Logout revokes the grant server-side (best effort) and
clears the credentials; the user can also rename or revoke any agent in the
OddsBot web app.`

// Validate the entire command before authentication or any network access.
// Canonical positionals-first output keeps every handler independent of where
// the caller placed its options.
function parseCommand(command, argv) {
  const paging = { '--limit': 'value', '--cursor': 'value' }
  const discovery = { ...paging, '--sort': 'value', '--tag': 'value' }
  const schemas = {
    help: [0, 0, {}], '--help': [0, 0, {}],
    status: [0, 0, {}], capabilities: [0, 0, {}], logout: [0, 0, {}], balance: [0, 0, {}],
    orders: [0, 0, {}], trades: [0, 0, {}], approvals: [0, 0, {}], sports: [0, 0, {}],
    login: [0, 0, { '--trade': 'boolean', '--no-poll': 'boolean', '--code': 'value', '--name': 'value', '--auto-name': 'boolean' }],
    name: [0, Infinity, {}],
    api: [2, 2, { '--json': 'value' }],
    markets: [0, Infinity, discovery], events: [0, Infinity, discovery],
    market: [1, 1, {}], event: [1, 1, {}],
    book: [1, 1, { '--depth': 'value' }],
    history: [1, 1, { '--interval': 'value', '--fidelity': 'value' }],
    positions: [0, 0, { '--all': 'boolean', '--closed': 'boolean', '--limit': 'value', '--offset': 'value' }],
    order: [3, 3, { '--intent': 'value', '--max-slippage': 'value', '--wait': 'optional-number', '--post-only': 'boolean', '--allow-off-market': 'boolean' }],
    quote: [3, 3, { '--intent': 'value', '--max-slippage': 'value', '--post-only': 'boolean', '--allow-off-market': 'boolean' }],
    'approval-status': [1, 1, {}], 'order-status': [1, 1, {}], 'intent-status': [1, 1, {}],
    holders: [1, 1, { '--limit': 'value' }], 'open-interest': [1, 1, {}], 'live-volume': [1, 1, {}],
    leaderboard: [0, 0, { '--window': 'value', '--by': 'value', '--category': 'value', '--limit': 'value' }],
    portfolio: [1, 1, { '--limit': 'value' }], tags: [0, Infinity, paging],
    tag: [1, 1, { '--limit': 'value' }], series: [0, 1, paging], teams: [1, 1, { '--limit': 'value' }],
    cancel: [0, 1, { '--all': 'boolean', '--token': 'value', '--market': 'value' }],
    heartbeat: [0, 0, { '--status': 'boolean', '--off': 'boolean', '--ttl': 'value' }],
    manifest: [0, 0, { '--dir': 'value', '--declare': 'boolean', '--files': 'boolean' }],
    agent: [2, 2, { '--name': 'value' }],
  }
  const schema = schemas[command]
  if (!schema) return argv
  const [min, max, options] = schema
  const words = []
  const flags = new Map()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('-')) { words.push(arg); continue }
    const kind = arg === '--json' && command !== 'api' ? 'boolean' : options[arg]
    if (!kind) die(`Unknown option for ${command}: ${arg}`)
    if (flags.has(arg)) die(`Duplicate option: ${arg}`)
    if (kind === 'value') {
      const value = argv[++i]
      if (value === undefined || value === '' || value.startsWith('--')) die(`${arg} requires a value`)
      flags.set(arg, value)
    } else if (kind === 'optional-number' && /^\d+$/.test(argv[i + 1] ?? '')) {
      flags.set(arg, argv[++i])
    } else { flags.set(arg, true) }
  }
  if (words.length < min || words.length > max) die(`Invalid arguments for ${command}. Run oddsbot.mjs --help.`)
  const exclusive = (names) => {
    if (names.filter((name) => flags.has(name)).length > 1) die(`${names.join(', ')} are mutually exclusive`)
  }
  if (command === 'login') {
    exclusive(['--code', '--no-poll'])
    exclusive(['--name', '--auto-name'])
    for (const flag of ['--trade', '--name', '--auto-name']) {
      if (flags.has(flag) && flags.has('--code')) die(`${flag} must be given when starting login`)
    }
  }
  if (command === 'positions') exclusive(['--all', '--closed'])
  if (command === 'heartbeat') exclusive(['--status', '--off', '--ttl'])
  if (command === 'cancel') {
    exclusive(['--token', '--market'])
    if (flags.has('--all') ? words.length !== 0 : words.length !== 1) die('Use cancel <order_id> or cancel --all with an optional filter')
    if (!flags.has('--all') && (flags.has('--token') || flags.has('--market'))) die('Cancellation filters require --all')
  }
  if (command === 'series' && words.length && flags.has('--cursor')) die('--cursor is for series listings')
  if (['order', 'quote'].includes(command) && flags.has('--max-slippage') && !words[2].endsWith('@market')) die('--max-slippage requires @market')
  for (const flag of ['--limit', '--offset', '--depth', '--fidelity', '--max-slippage', '--ttl']) {
    if (!flags.has(flag)) continue
    const value = flags.get(flag)
    const lower = ['--offset', '--max-slippage'].includes(flag) ? 0 : 1
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < lower) die(`${flag} requires a whole number of at least ${lower}`)
  }
  if (flags.has('--wait') && flags.get('--wait') !== true && Number(flags.get('--wait')) > 60000) die('--wait must be at most 60000 milliseconds')
  if (command === 'api') {
    if (!['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD'].includes(words[0].toUpperCase())) die('Unsupported API method')
    return [...words, ...(flags.has('--json') ? [flags.get('--json')] : [])]
  }
  return [...words, ...[...flags].filter(([key]) => key !== '--json').flatMap(([key, value]) => value === true ? [key] : [key, value])]
}

async function main() {
  const [command, ...raw] = process.argv.slice(2)
  const rest = parseCommand(command, raw)
  switch (command) {
    case 'status':
      return cmdStatus()
    case 'capabilities':
      return cmdApi(['GET', '/api/v1/capabilities'])
    case 'login': {
      const withTrade = rest.includes('--trade')
      const naming = { name: rest.includes('--name') ? rest[rest.indexOf('--name') + 1] : undefined, auto: rest.includes('--auto-name') }
      if (rest.includes('--code')) return cmdLoginCode(rest[rest.indexOf('--code') + 1])
      // Agents run without a terminal: they relay the URL and the user's code.
      if (rest.includes('--no-poll') || !process.stdin.isTTY) return cmdLoginStart(withTrade, process.stdout, naming)
      await cmdLoginStart(withTrade, process.stderr, naming)
      return cmdLoginInteractive()
    }
    case 'name':
      return cmdName(rest)
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
    case 'history':
      return cmdHistory(rest)
    case 'events':
      return cmdEvents(rest)
    case 'event':
      return cmdEvent(rest)
    case 'positions':
      return cmdPositions(rest)
    case 'order':
      return cmdOrder(rest)
    case 'quote':
      return cmdOrder(rest, true)
    case 'approval-status':
      return cmdApprovalStatus(rest)
    case 'approvals':
      return cmdApi(['GET', '/api/v1/polymarket/approvals'])
    case 'holders':
      return cmdHolders(rest)
    case 'open-interest':
      return cmdOpenInterest(rest)
    case 'live-volume':
      return cmdLiveVolume(rest)
    case 'leaderboard':
      return cmdLeaderboard(rest)
    case 'portfolio':
      return cmdPortfolio(rest)
    case 'tags':
      return cmdTags(rest)
    case 'tag':
      return cmdTag(rest)
    case 'series':
      return cmdSeries(rest)
    case 'sports':
      return cmdApi(['GET', '/api/v1/polymarket/sports'])
    case 'teams':
      return cmdTeams(rest)
    case 'orders':
      return cmdApi(['GET', '/api/v1/polymarket/orders'])
    case 'order-status':
      return cmdOrderStatus(rest)
    case 'intent-status':
      if (!/^[\w.:-]{8,128}$/.test(rest[0])) die('Invalid intent_id')
      return cmdApi(['GET', `/api/v1/polymarket/intents/${encodeURIComponent(rest[0])}`])
    case 'cancel':
      return cmdCancel(rest)
    case 'heartbeat':
      return cmdHeartbeat(rest)
    case 'trades':
      return cmdApi(['GET', '/api/v1/polymarket/trades'])
    case 'manifest':
      return cmdManifest(rest)
    case 'agent':
      return cmdAgentInit(rest)
    case 'help':
    case '--help':
    case undefined:
      console.log(raw.includes('--json') ? JSON.stringify({ help: HELP }) : HELP)
      return
    default:
      die(`Unknown command: ${command}\n\n${HELP}`)
  }
}

main().catch((error) => {
  process.stderr.write(String(error?.message ?? error) + '\n')
  console.log(JSON.stringify({ error: error instanceof CliError ? 'command_failed' : 'request_failed',
    state: 'unknown', next_action: RECOVER_UNKNOWN,
    ...(error instanceof CliError ? error.details : {}),
  }))
  process.exitCode = error instanceof CliError ? error.code : 1
})
