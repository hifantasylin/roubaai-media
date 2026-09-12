/**
 * OpenAI-compatible facade over the media registry.
 *
 * The canvas workbench talks to a generation backend as an OpenAI-compatible
 * channel: `POST <baseUrl>/v1/images/generations` for text-to-image, the
 * multipart `/v1/images/edits` for a reference edit, and `/v1/videos` with a
 * task poll for video. Serving those shapes from the harness host is what keeps
 * the provider key in the host process — the browser only ever holds a
 * same-origin URL — while the call still goes through the same provider registry
 * the agent tools use, so the backend that serves the agent also serves the
 * canvas.
 *
 * Paths are accepted with and without the `/v1` segment: a caller that appends
 * `/v1` to a base URL ending in `/openai` and one that does not must both land
 * here, and guessing which is a URL-shaped coin flip.
 *
 * What this module does NOT do yet, deliberately:
 * - the video task endpoints and the multipart edit body answer 501 with a
 *   stated reason instead of 404 (`unsupported` below), so a wrong URL and an
 *   unimplemented one stay distinguishable;
 * - no cost-ledger entry and no `.assets` landing. Both need the rate table and
 *   the asset pipeline the `generate_*` tools own, and wiring them without that
 *   reuse would put numbers in the ledger that nothing verified. The response
 *   says so in its `roubaai` block instead of implying a record exists.
 *
 * @module @roubaai/media/openai-facade
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context augmentation (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
import { MEDIA_ROUTE_PREFIX, downloadToCache } from './media-cache.ts'
import { MEDIA_SETTINGS_NAMESPACE, readActiveAdapter, readActiveMediaProvider } from './settings-lookup.ts'
import type { ImageGenerateInput, ImageGenerationResult } from './provider.ts'

/** Route prefix on the host webserver, under the media routes. */
export const OPENAI_FACADE_PREFIX = `${MEDIA_ROUTE_PREFIX}/openai`

/** Longest request body accepted, in bytes. A prompt is not a payload. */
const MAX_BODY_BYTES = 1024 * 1024

/** Image endpoints, both spellings of the `/v1` segment. */
const IMAGE_GENERATION_PATHS = new Set(['/v1/images/generations', '/images/generations'])
/** Reference-edit endpoints (multipart body; not implemented yet). */
const IMAGE_EDIT_PATHS = new Set(['/v1/images/edits', '/images/edits'])

/** Header a caller uses to name the workspace the run should be billed to. */
export const WORKSPACE_HEADER = 'x-roubaai-workspace'

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Whether a request came from the host's own origin.
 *
 * A browser fetch always states its origin, so a mismatching `Origin` is a
 * cross-site page reaching for the local backend and is refused. A caller with
 * no origin header at all (curl, the agent) is not a browser and is allowed —
 * the routes bind to loopback, which is the actual boundary.
 * @param req - the incoming request.
 * @returns true when the request may proceed.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  const host = req.headers.host
  if (host === undefined || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read the whole request body, refusing anything past the byte cap. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(undefined))
  })
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Translate an OpenAI image request into the provider seam's input.
 *
 * `size` is spelled `WxH` by the OpenAI shape and as a tier name by this
 * deployment's settings; both reach here, so a value that parses as pixels is
 * passed as pixels and anything else is left to the provider's own tier
 * validation. Nothing is invented for a field the caller omitted.
 * @param body - the parsed request body.
 * @returns the provider input plus the fields that were ignored.
 */
export function mapImageRequest(body: Record<string, unknown>): { input: ImageGenerateInput; ignored: string[] } {
  const ignored: string[] = []
  const input: ImageGenerateInput = { prompt: stringField(body, 'prompt') ?? '' }
  const model = stringField(body, 'model')
  if (model !== undefined) input.model = model
  const quality = stringField(body, 'quality')
  if (quality !== undefined) input.quality = quality

  const size = stringField(body, 'size')
  const pixels = size === undefined ? undefined : /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size)
  if (pixels !== null && pixels !== undefined) {
    input.width = Number(pixels[1])
    input.height = Number(pixels[2])
  } else if (size !== undefined && size !== 'auto') {
    // A tier name this deployment's settings use (`2K`, `1.5K`); the provider
    // validates it against the serving model and refuses what it cannot serve.
    input.resolution = size
  }

  const ratio = stringField(body, 'aspect_ratio') ?? stringField(body, 'aspectRatio')
  if (ratio !== undefined) input.aspectRatio = ratio

  for (const key of Object.keys(body)) {
    if (!['prompt', 'model', 'quality', 'size', 'aspect_ratio', 'aspectRatio', 'n', 'response_format'].includes(key)) {
      ignored.push(key)
    }
  }
  if (body['n'] !== undefined && body['n'] !== 1) ignored.push('n')
  return { input, ignored }
}

/**
 * The URL the browser should load the finished image from.
 *
 * The provider's own result URL is a 24h CDN link, so a locally cached signed
 * stream is preferred when the bytes are already on disk; nothing here downloads
 * anything, which is why a run that has not been cached still answers with the
 * CDN URL rather than not answering at all.
 * @param result - the provider's result.
 * @returns the preferred URL, or undefined when the provider stated none.
 */
export function imageUrlOf(result: ImageGenerationResult): string | undefined {
  return result.mediaRef?.localUrl ?? result.resultUrl ?? result.mediaRef?.url
}

/**
 * The provider's own URL, ignoring any local copy it already carries.
 * @param result - the provider's result.
 * @returns the remote URL, or undefined when the provider stated none.
 */
function remoteUrlOf(result: ImageGenerationResult): string | undefined {
  return result.resultUrl ?? result.mediaRef?.url
}

/**
 * Answer one OpenAI-shaped request.
 * @param ctx - the plugin context (the media registry is read off it).
 * @param req - the incoming request.
 * @param res - the response to write.
 * @param url - the parsed request URL.
 */
export async function handleOpenAiRequest(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'method not allowed', type: 'invalid_request_error' } })
    return
  }
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: { message: 'cross-origin request refused', type: 'invalid_request_error' } })
    return
  }

  const path = url.pathname.slice(OPENAI_FACADE_PREFIX.length) || '/'
  if (IMAGE_EDIT_PATHS.has(path)) {
    sendJson(res, 501, {
      error: {
        message: 'image edits are not served yet: the multipart /v1/images/edits body is unimplemented',
        type: 'unsupported_error',
      },
    })
    return
  }
  if (!IMAGE_GENERATION_PATHS.has(path)) {
    sendJson(res, 404, { error: { message: `unknown facade path ${path}`, type: 'invalid_request_error' } })
    return
  }

  const raw = await readBody(req)
  if (raw === undefined) {
    sendJson(res, 400, { error: { message: 'request body missing or larger than 1 MiB', type: 'invalid_request_error' } })
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    sendJson(res, 400, { error: { message: 'request body is not JSON', type: 'invalid_request_error' } })
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, { error: { message: 'request body must be a JSON object', type: 'invalid_request_error' } })
    return
  }
  const body = parsed as Record<string, unknown>
  const { input, ignored } = mapImageRequest(body)
  if (input.prompt === '') {
    sendJson(res, 400, { error: { message: 'prompt must be a non-empty string', type: 'invalid_request_error' } })
    return
  }

  // Route through the backend the Settings page activated for images, exactly
  // as `generate_image` does: a row that names no adapter keeps the deployment's
  // registry default, which is the first provider registered.
  const adapter = readActiveAdapter(ctx, 'image')
  let provider
  try {
    provider = adapter === undefined ? ctx.media.image() : ctx.media.image(adapter)
  } catch (error) {
    sendJson(res, 503, {
      error: {
        message: `no image provider is available: ${error instanceof Error ? error.message : String(error)}`,
        type: 'service_unavailable_error',
      },
    })
    return
  }
  // The tier the row stores is the deployment's stated preference; the canvas
  // cannot know it, and a provider that states no capability passes it through
  // untouched.
  const rowTier = readActiveMediaProvider(ctx, MEDIA_SETTINGS_NAMESPACE, 'image').resolution
  if (input.resolution === undefined && rowTier !== undefined) input.resolution = rowTier

  const controller = new AbortController()
  let result: ImageGenerationResult
  try {
    result = await provider.generate(input, controller.signal)
  } catch (error) {
    sendJson(res, 502, {
      error: { message: `image generation failed: ${error instanceof Error ? error.message : String(error)}`, type: 'upstream_error' },
    })
    return
  }

  // Cache the provider's 24h URL on first sight, so the canvas stores a URL that
  // outlives the CDN link. A failed download keeps the CDN URL the run already
  // has: the image exists, and saying so beats reporting a caching problem as a
  // failed generation.
  const remote = remoteUrlOf(result)
  const stable = result.mediaRef?.localUrl ?? (remote === undefined ? undefined : await downloadToCache({
    url: remote,
    mediaType: result.mediaType,
    fallbackExt: 'png',
    log: (message) => ctx.logger.warn(`roubaai-media: ${message}`),
  }))
  const url_ = stable ?? imageUrlOf(result)
  if (url_ === undefined) {
    sendJson(res, 502, {
      error: { message: 'the provider returned no image URL', type: 'upstream_error' },
    })
    return
  }

  sendJson(res, 200, {
    created: Math.floor(Date.now() / 1000),
    data: [{ url: url_ }],
    roubaai: {
      provider: result.providerMeta.provider,
      model: result.providerMeta.model,
      ...(input.resolution === undefined ? {} : { tier: input.resolution }),
      ...(result.run?.size === undefined ? {} : { size: result.run.size }),
      // Stated rather than implied: until the asset pipeline is wired to this
      // path, a canvas run leaves no file under `.assets`. The URL it answers
      // with is already cached locally, so it outlives the provider's CDN link.
      ledger: false,
      landed: false,
      ...(ignored.length === 0 ? {} : { ignored }),
    },
  })
}

/**
 * Register the facade on the host webserver.
 * @param ctx - the plugin context.
 * @returns the disposer removing the route.
 */
export function registerOpenAiRoutes(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: OPENAI_FACADE_PREFIX,
    handler: (req, res): void => {
      void handleOpenAiRequest(ctx, req, res, new URL(req.url ?? OPENAI_FACADE_PREFIX, 'http://dsh.internal'))
    },
  })
}
