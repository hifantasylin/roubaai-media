/**
 * Host half of `@roubaai/settings`: owns the provider-configuration
 * settings namespace and serves it to the Web configuration surface through
 * the plugin's own fenced JSON route.
 *
 * The namespace is registered HERE, in the host plane, for two reasons: the
 * registration is then a process-wide singleton (an agent preset's isolated
 * realm registers and unregisters per session, which would make a settings
 * namespace flicker with the session lifecycle), and the write path stays on
 * the same plane as the settings document it persists to.
 *
 * The route exists because the DSH settings RPC domain serves only allowlisted
 * namespaces to configuration clients: a third-party namespace reaches its own
 * browser surface through a fenced route that calls the settings seam
 * in-process. Reads are always redacted (no API key crosses the wire); writes
 * are revision-guarded so a stale editor is refused instead of silently
 * overwriting a concurrent change.
 *
 * On mount the plugin migrates the pre-3-category flat shape (one shared
 * `apiKey`/`baseUrl` + per-kind model overrides) into the per-category
 * provider structure, then rewrites the user section without the legacy
 * fields — a one-time, idempotent rewrite guarded by the legacy fields'
 * presence.
 * @module @roubaai/settings
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_PROVIDER_ID,
  MEDIA_CATEGORY_DEFAULTS,
  ROUBAAI_SETTINGS_NS,
  RoubaaiMediaSettingsSchema,
} from './config.ts'

/**
 * Stable Cordis plugin name. Intentionally NOT the settings namespace: the
 * namespace (`ROUBAAI_SETTINGS_NS`) is the data contract the media providers
 * read, so it stays put even when this package's npm name changes.
 */
export const name = 'roubaai-settings'

/** Services required before the namespace and its route can be mounted. */
export const inject = ['webServer', 'settings']

/** The JSON API prefix (`POST <prefix>/<method>`). */
export const API_PREFIX = '/api/roubaai-video'

/** Upper bound on one connection test (the browser waits on this route). */
const TEST_TIMEOUT_MS = 15_000

/** Upper bound on a JSON request body (the settings patch is tiny). */
const MAX_BODY_BYTES = 64 * 1024

/** Wire code of a refused stale write (mirrors `SettingsConflictError.code`). */
const CONFLICT_CODE = 'SETTINGS_CONFLICT'

/**
 * Whether a request comes from this origin. A browser sends `Origin` on every
 * cross-origin POST and on same-origin POSTs with a non-GET method, so a
 * present-but-foreign `Origin` is refused: it is the one header a page on
 * another host cannot forge or suppress. A request with no `Origin` at all is
 * a non-browser client (the CLI, curl, an integration), which no CSRF page can
 * produce, so it is admitted.
 * @param req - the incoming request.
 * @returns whether the request may reach the handlers.
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host
  const origin = req.headers.origin
  if (host === undefined || host === '') return false
  if (origin === undefined || origin === '') return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Send one JSON envelope. Every response — success and failure alike — uses
 * this shape so the client has a single parse path.
 * @param res - the response to write.
 * @param status - the HTTP status.
 * @param body - the JSON-serializable body.
 */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Send one failure envelope (`{ ok: false, error: { code, message } }`). */
function writeError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/**
 * Read the request body as JSON, bounded. A body past the cap (or one that is
 * not an object) is refused before any handler sees it: this route writes
 * credentials, so its input is never trusted and never unbounded.
 * @param req - the incoming request.
 * @returns the parsed object body.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${String(MAX_BODY_BYTES)} bytes`)
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Probe a provider endpoint with a key: one `GET /models` on the
 * OpenAI-compatible base. It is the cheapest request that still proves both
 * halves of the configuration — the endpoint answers, and the key is accepted
 * — without spending a generation. The caller supplies the values it is
 * looking at (an unsaved key included), so a key can be verified in the same
 * breath it is typed.
 *
 * @param baseUrl - the endpoint base to probe.
 * @param apiKey - the key to present.
 * @returns whether the endpoint answered favorably, plus the human reason.
 */
export async function testConnection(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: boolean; message: string }> {
  if (apiKey.trim() === '') return { ok: false, message: '未填写 API Key' }
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base === '') return { ok: false, message: '未填写接口地址' }
  try {
    const response = await fetch(`${base}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    if (response.ok) return { ok: true, message: `连接成功（HTTP ${String(response.status)}）` }
    return { ok: false, message: response.status === 401 || response.status === 403
      ? `API Key 被拒绝（HTTP ${String(response.status)}）`
      : `端点返回 HTTP ${String(response.status)}` }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `无法连接端点：${reason}` }
  }
}

/** The legacy flat shape this plugin stored before the per-category rewrite. */
interface LegacyFlatSettings {
  apiKey?: unknown
  baseUrl?: unknown
  imageModel?: unknown
  videoModel?: unknown
  musicApiKey?: unknown
  musicModel?: unknown
}

/**
 * One-time migration: fold the legacy flat shape into the per-category
 * structure. The old document held one shared Maizi key/endpoint plus
 * per-kind model overrides; they become each category's default provider
 * (and the music key its own). Idempotent: the rewrite drops the legacy
 * fields, so the guard (any legacy key set) fires at most once.
 * @param ctx - the plugin context carrying the settings service.
 */
async function migrateLegacySettings(ctx: Context): Promise<void> {
  const descriptor = ctx.settings.describe().find((candidate) => candidate.ns === ROUBAAI_SETTINGS_NS)
  const value = descriptor?.value as LegacyFlatSettings | undefined
  if (typeof value !== 'object' || value === null) return
  const string = (key: keyof LegacyFlatSettings): string =>
    typeof value[key] === 'string' ? value[key] as string : ''
  const apiKey = string('apiKey')
  const musicApiKey = string('musicApiKey')
  if (apiKey === '' && musicApiKey === '' && string('baseUrl') === ''
    && string('imageModel') === '' && string('videoModel') === '' && string('musicModel') === '') {
    return
  }
  const baseUrl = string('baseUrl')
  const sharedKey = apiKey === '' ? {} : {
    [`${DEFAULT_PROVIDER_ID}:image`]: apiKey,
    [`${DEFAULT_PROVIDER_ID}:video`]: apiKey,
  }
  await ctx.settings.replace(ROUBAAI_SETTINGS_NS, {
    image: {
      activeId: DEFAULT_PROVIDER_ID,
      providers: [{ id: `${DEFAULT_PROVIDER_ID}:image`, name: '', custom: false, baseUrl, model: string('imageModel') }],
    },
    video: {
      activeId: DEFAULT_PROVIDER_ID,
      providers: [{ id: `${DEFAULT_PROVIDER_ID}:video`, name: '', custom: false, baseUrl, model: string('videoModel') }],
    },
    music: {
      activeId: DEFAULT_PROVIDER_ID,
      providers: [{
        id: `${DEFAULT_PROVIDER_ID}:music`, name: '', custom: false,
        baseUrl: MEDIA_CATEGORY_DEFAULTS.music.baseUrl, model: string('musicModel'),
      }],
    },
    keys: { ...sharedKey, ...(musicApiKey === '' ? {} : { [`${DEFAULT_PROVIDER_ID}:music`]: musicApiKey }) },
  })
}

/**
 * Probe the music provider endpoint with a key. The music API is not
 * OpenAI-compatible: it has no `GET /models`, so the cheapest authenticated
 * probe is a task lookup — an unknown id answers a business-JSON 404 ("任务
 * 不存在"), which still proves the endpoint is reachable and the key accepted
 * (an unauthorized key is refused before the id is ever read).
 *
 * @param baseUrl - the music endpoint base (…/api/v2/music).
 * @param apiKey - the key to present.
 * @returns whether the endpoint answered favorably, plus the human reason.
 */
export async function testMusicConnection(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: boolean; message: string }> {
  if (apiKey.trim() === '') return { ok: false, message: '未填写 API Key' }
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base === '') return { ok: false, message: '未填写接口地址' }
  try {
    const response = await fetch(`${base}/task?id=connection-probe`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    if (response.ok) return { ok: true, message: `连接成功（HTTP ${String(response.status)}）` }
    // The API answers an unknown id with HTTP 404 carrying a business JSON
    // body ("任务不存在") — that is the expected no-such-task answer, and it
    // proves both reachability and acceptance (an unauthorized key is
    // refused by the auth middleware before the id is read). A plain 404
    // without that JSON shape is a genuine missing route.
    if (response.status === 404) {
      const body = await response.json().catch(() => undefined) as { code?: unknown; message?: unknown } | undefined
      if (typeof body === 'object' && body !== null && body['code'] !== undefined) {
        return { ok: true, message: `连接成功（HTTP 404，${String(body['message'] ?? '任务不存在')}）` }
      }
    }
    return { ok: false, message: response.status === 401 || response.status === 403
      ? `API Key 被拒绝（HTTP ${String(response.status)}）`
      : `端点返回 HTTP ${String(response.status)}` }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `无法连接端点：${reason}` }
  }
}

/**
 * Register the provider-configuration namespace and mount its fenced JSON
 * route.
 *
 * Three methods share the prefix: `settings.get` (redacted view + revision),
 * `settings.update` (revision-guarded deep-merge patch), and `test` (an
 * endpoint probe against the values the caller is looking at, unsaved key
 * included; music probes a task lookup, the OpenAI-compatible categories
 * probe `/models`). The legacy migration runs once before the route mounts.
 * @param ctx - plugin context carrying the webServer and settings services.
 */
export function apply(ctx: Context): void {
  // `register` books its own disposal effect on this fiber — the registration
  // is removed when the plugin unloads — and answers a scope, not a disposer,
  // so wrapping it in another `ctx.effect` would be a type error.
  ctx.settings.register(ROUBAAI_SETTINGS_NS, RoubaaiMediaSettingsSchema)

  /** The redacted view of this namespace (secrets absent, slots enumerated). */
  const viewOf = (): { value: unknown; revision: number | undefined; secrets: { path: string[]; set: boolean }[] } => {
    const descriptor = ctx.settings.describe({ redactSecrets: true })
      .find((candidate) => candidate.ns === ROUBAAI_SETTINGS_NS)
    if (descriptor === undefined) return { value: undefined, revision: undefined, secrets: [] }
    return { value: descriptor.value, revision: descriptor.revision, secrets: descriptor.secrets ?? [] }
  }

  const handlers: Record<string, (payload: Record<string, unknown>) => Promise<unknown>> = {
    'settings.get': async () => viewOf(),
    'settings.update': async (payload) => {
      const patch = payload['patch']
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw new Error('patch must be an object')
      }
      const expected = payload['expectedRevision']
      const expectedRevision = typeof expected === 'number' ? expected : undefined
      try {
        await ctx.settings.update(ROUBAAI_SETTINGS_NS, patch, expectedRevision)
      } catch (error) {
        const code = error instanceof Error && 'code' in error
          ? String((error as { code?: unknown }).code)
          : ''
        if (code === CONFLICT_CODE) {
          const failure: Error & { status?: number } = new Error('配置已被其他端修改，请刷新后重试')
          failure.status = 409
          throw failure
        }
        throw error
      }
      return viewOf()
    },
    'test': async (payload) => {
      // The caller supplies what it is looking at (an unsaved key included):
      // the probe runs against the card's draft rather than the last commit.
      // Music probes a task lookup (no /models route exists there); the
      // OpenAI-compatible categories probe /models.
      const baseUrl = typeof payload['baseUrl'] === 'string' ? payload['baseUrl'] : ''
      const apiKey = typeof payload['apiKey'] === 'string' ? payload['apiKey'] : ''
      return payload['kind'] === 'music'
        ? testMusicConnection(baseUrl, apiKey)
        : testConnection(baseUrl, apiKey)
    },
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'POST') {
        writeError(res, 405, 'method-error', 'method not allowed')
        return
      }
      if (!isSameOrigin(req)) {
        writeError(res, 403, 'forbidden', 'cross-origin request refused')
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${API_PREFIX}/`)
        ? pathname.slice(API_PREFIX.length + 1)
        : undefined
      const handler = method === undefined ? undefined : handlers[method]
      if (handler === undefined) {
        writeError(res, 404, 'not-found', `unknown roubaai video API method "${method ?? ''}"`)
        return
      }
      try {
        const payload = await readJsonBody(req)
        writeJson(res, 200, { ok: true, value: await handler(payload) })
      } catch (error) {
        const status = error instanceof Error && 'status' in error
          ? Number((error as { status?: unknown }).status)
          : undefined
        const message = error instanceof Error ? error.message : String(error)
        writeError(res, Number.isFinite(status) && (status ?? 0) >= 400 ? (status ?? 500) : 500,
          status === 409 ? 'settings-conflict' : 'handler-error', message)
      }
    },
  }), `@roubaai/settings: ${API_PREFIX} routes`)

  // Fold a legacy flat document into the per-category structure once. A
  // failure leaves the legacy fields in place, so the next boot retries.
  void migrateLegacySettings(ctx).catch(() => { /* retried on the next boot */ })
}

export default { name, inject, apply }
