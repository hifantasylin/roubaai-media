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
 *   unimplemented one stay distinguishable.
 *
 * A finished image is cached on the host and landed into
 * `<workspace>/.assets/<project>/<dir>/` with an index row and a cost-ledger
 * entry, exactly as a `generate_image` call would — the caller names the
 * destination with headers, and the defaults keep a canvas run self-describing
 * (`default/90_画布/canvas-<timestamp>`).
 *
 * @module @roubaai/media/openai-facade
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context augmentation (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
import { MEDIA_ROUTE_PREFIX, cachedMediaBytes, cachedMediaFile, downloadToCache } from './media-cache.ts'
import { landMediaAsset } from './asset-landing.ts'
import { appendMediaCost } from './cost-ledger.ts'
import { fileFields, parseMultipart, textField } from './multipart.ts'
import { MEDIA_SETTINGS_NAMESPACE, readActiveAdapter, readActiveMediaProvider } from './settings-lookup.ts'
import type { ImageGenerateInput, ImageGenerationResult, VideoGenerateInput, VideoProvider, VideoTaskHandle } from './provider.ts'

/** Route prefix on the host webserver, under the media routes. */
export const OPENAI_FACADE_PREFIX = `${MEDIA_ROUTE_PREFIX}/openai`

/** Longest request body accepted, in bytes. A prompt is not a payload. */
const MAX_BODY_BYTES = 1024 * 1024

/** Image endpoints, both spellings of the `/v1` segment. */
const IMAGE_GENERATION_PATHS = new Set(['/v1/images/generations', '/images/generations'])
/** Reference-edit endpoints (multipart body; not implemented yet). */
const IMAGE_EDIT_PATHS = new Set(['/v1/images/edits', '/images/edits'])
/** Video task endpoints: create, then poll, then fetch content. */
const VIDEO_CREATE_PATHS = new Set(['/v1/videos', '/videos'])
const VIDEO_TASK_PATH = /^\/(?:v1\/)?videos\/([^/]+)$/
const VIDEO_CONTENT_PATH = /^\/(?:v1\/)?videos\/([^/]+)\/content$/

/** How long a submitted video task stays addressable, in milliseconds. */
const VIDEO_TASK_TTL_MS = 2 * 60 * 60 * 1000

/** One submitted video task, as the facade tracks it between polls. */
interface VideoTaskEntry {
  readonly handle: VideoTaskHandle
  readonly provider: VideoProvider
  readonly model: string
  readonly duration: number
  readonly resolution: string
  readonly createdAt: number
  /** Set once the task finished and its bytes were cached, so later polls are free. */
  completed?: { url: string; sourceUrl: string; assetPath?: string; ledger: boolean }
}

/** Live video tasks by the id the canvas polls with. */
const videoTasks = new Map<string, VideoTaskEntry>()

function pruneVideoTasks(): void {
  const cutoff = Date.now() - VIDEO_TASK_TTL_MS
  for (const [id, entry] of videoTasks) {
    if (entry.createdAt < cutoff) videoTasks.delete(id)
  }
}


/** Header a caller uses to name the workspace the run should be billed to. */
export const WORKSPACE_HEADER = 'x-roubaai-workspace'
/** Header naming the project folder under `.assets/`. */
export const PROJECT_HEADER = 'x-roubaai-project'
/** Header naming the landing sub-directory under the project. */
export const DIR_HEADER = 'x-roubaai-dir'
/** Header naming the asset (extension added by the landing rules). */
export const NAME_HEADER = 'x-roubaai-name'
/** Header naming the asset category. */
export const CATEGORY_HEADER = 'x-roubaai-category'

/** Where a canvas run lands when the caller names nothing. */
const DEFAULT_PROJECT = 'default'
const DEFAULT_DIR = '90_画布'
const DEFAULT_CATEGORY = 'keyframe'

/** One request header, tolerating the array form node may hand back. */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/** A file-name-safe timestamp, so two canvas runs never collide. */
function timestampName(): string {
  return `canvas-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
}

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

/** Read the whole request body as bytes, refusing anything past the byte cap. */
async function readBodyBuffer(req: IncomingMessage): Promise<Buffer | undefined> {
  return await new Promise<Buffer | undefined>((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: Buffer | undefined): void => {
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
    req.on('end', () => finish(Buffer.concat(chunks)))
    req.on('error', () => finish(undefined))
  })
}

/** Read the body as text (a JSON request); multipart readers use the byte form. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const buffer = await readBodyBuffer(req)
  return buffer?.toString('utf8')
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
  if (!sameOrigin(req)) {
    sendJson(res, 403, { error: { message: 'cross-origin request refused', type: 'invalid_request_error' } })
    return
  }

  const path = url.pathname.slice(OPENAI_FACADE_PREFIX.length) || '/'
  // Video is a task protocol: create, poll, fetch. Each verb is checked where it
  // belongs, because a poll is a GET while every other endpoint is a POST.
  if (VIDEO_CREATE_PATHS.has(path)) {
    await createVideoTask(ctx, req, res)
    return
  }
  const contentMatch = VIDEO_CONTENT_PATH.exec(path)
  if (contentMatch !== null) {
    await serveVideoContent(res, contentMatch[1] ?? '')
    return
  }
  const taskMatch = VIDEO_TASK_PATH.exec(path)
  if (taskMatch !== null) {
    await pollVideoTask(ctx, req, res, taskMatch[1] ?? '')
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'method not allowed', type: 'invalid_request_error' } })
    return
  }
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

  // Land the bytes and record the run, the same way `generate_image` does.
  const tier = input.resolution ?? '1K'
  const recorded = await recordCanvasRun({
    ctx,
    req,
    remoteUrl: remote,
    ext: 'png',
    defaultDir: DEFAULT_DIR,
    defaultCategory: DEFAULT_CATEGORY,
    tool: 'image',
    model: result.providerMeta.model,
    providerName: result.providerMeta.provider,
    spec: tier,
    costUsd: provider.estimateCostUsd(result.providerMeta.model, tier) ?? 0,
  })

  sendJson(res, 200, {
    created: Math.floor(Date.now() / 1000),
    data: [{ url: url_ }],
    roubaai: {
      provider: result.providerMeta.provider,
      model: result.providerMeta.model,
      tier,
      ...(result.run?.size === undefined ? {} : { size: result.run.size }),
      ledger: recorded.ledger,
      landed: recorded.landed !== undefined,
      ...(recorded.landed === undefined ? {} : { assetPath: recorded.landed }),
      ...(ignored.length === 0 ? {} : { ignored }),
    },
  })
}

/** Video defaults: the shot folder and category a generated clip belongs to. */
const DEFAULT_VIDEO_DIR = '05_视频片段'
const DEFAULT_VIDEO_CATEGORY = 'video'

/**
 * Land one finished run's bytes and record its cost.
 *
 * Both steps are best-effort: the media exists and its URL is in hand, so a
 * filesystem or ledger problem is reported in the response instead of turning a
 * finished generation into one the caller would retry.
 * @param options - the run's identity, its bytes' source URL, and its billing facts.
 * @returns the landed path when one exists, and whether the ledger took the entry.
 */
async function recordCanvasRun(options: {
  ctx: Context
  req: IncomingMessage
  remoteUrl: string | undefined
  ext: string
  defaultDir: string
  defaultCategory: string
  tool: 'image' | 'video'
  model: string
  providerName: string
  spec: string
  costUsd: number
}): Promise<{ landed?: string; ledger: boolean }> {
  const workspace = headerValue(options.req, WORKSPACE_HEADER) ?? process.cwd()
  const project = headerValue(options.req, PROJECT_HEADER) ?? DEFAULT_PROJECT
  const name = headerValue(options.req, NAME_HEADER) ?? timestampName()
  let landed: string | undefined
  const bytes = options.remoteUrl === undefined ? undefined : await cachedMediaBytes(options.remoteUrl)
  if (bytes !== undefined && options.remoteUrl !== undefined) {
    try {
      const asset = await landMediaAsset({
        workspace,
        project,
        dir: headerValue(options.req, DIR_HEADER) ?? options.defaultDir,
        name,
        ext: options.ext,
        bytes,
        category: headerValue(options.req, CATEGORY_HEADER) ?? options.defaultCategory,
        reference: options.remoteUrl,
        url: options.remoteUrl,
        displayUrl: options.remoteUrl,
      })
      landed = asset.path
    } catch (error) {
      options.ctx.logger.warn(`roubaai-media: canvas asset landing failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  let ledger = false
  try {
    await appendMediaCost(workspace, {
      ts: Date.now(),
      tool: options.tool,
      model: options.model,
      project,
      label: name,
      spec: options.spec,
      costUsd: options.costUsd,
      source: 'estimated',
      taskId: options.providerName,
    })
    ledger = true
  } catch (error) {
    options.ctx.logger.warn(`roubaai-media: canvas cost ledger append failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { ...(landed === undefined ? {} : { landed }), ledger }
}

/** The body one completed video poll answers with, in every spelling the client reads. */
function completedVideoBody(id: string, completed: NonNullable<VideoTaskEntry['completed']>): Record<string, unknown> {
  return {
    id,
    status: 'completed',
    url: completed.url,
    video_url: completed.url,
    result_url: completed.url,
    roubaai: {
      ledger: completed.ledger,
      landed: completed.assetPath !== undefined,
      ...(completed.assetPath === undefined ? {} : { assetPath: completed.assetPath }),
    },
  }
}

/** Submit one video task from the canvas's multipart body. */
async function createVideoTask(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'method not allowed', type: 'invalid_request_error' } })
    return
  }
  const body = await readBodyBuffer(req)
  if (body === undefined) {
    sendJson(res, 400, { error: { message: 'request body missing or larger than 1 MiB', type: 'invalid_request_error' } })
    return
  }
  const parts = parseMultipart(req.headers['content-type'], body)
  const prompt = textField(parts, 'prompt')
  if (prompt === undefined) {
    sendJson(res, 400, {
      error: { message: 'expected a multipart/form-data body with a non-empty prompt field', type: 'invalid_request_error' },
    })
    return
  }
  // Reference images have to reach the provider as URLs it can fetch; a
  // same-origin signed route is not one. Until they are republished through the
  // public-reference tunnel, say so instead of failing inside the provider.
  const references = [...fileFields(parts, 'image'), ...fileFields(parts, 'images')]
  if (references.length > 0) {
    sendJson(res, 501, {
      error: {
        message: 'reference images for video are not served yet: they must be republished through the public-reference tunnel first',
        type: 'unsupported_error',
      },
    })
    return
  }

  const adapter = readActiveAdapter(ctx, 'video')
  let provider: VideoProvider
  try {
    provider = adapter === undefined ? ctx.media.video() : ctx.media.video(adapter)
  } catch (error) {
    sendJson(res, 503, {
      error: {
        message: `no video provider is available: ${error instanceof Error ? error.message : String(error)}`,
        type: 'service_unavailable_error',
      },
    })
    return
  }

  const seconds = Number(textField(parts, 'seconds') ?? '')
  const size = textField(parts, 'size')
  // `size` carries pixels in the OpenAI video shape and a ratio elsewhere; only a
  // ratio can travel as `size`, so pixels are passed through as dimensions.
  const pixels = size === undefined ? undefined : /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size)
  const model = textField(parts, 'model')
  const resolution = textField(parts, 'resolution_name')
  const input: VideoGenerateInput = {
    prompt,
    ...(model === undefined ? {} : { model }),
    duration: Number.isFinite(seconds) && seconds > 0 ? seconds : 5,
    ...(resolution === undefined ? {} : { resolution }),
    ...(size === undefined || pixels !== null ? {} : { size }),
    ...(pixels === null || pixels === undefined ? {} : { extra: { width: Number(pixels[1]), height: Number(pixels[2]) } }),
    generateAudio: textField(parts, 'generate_audio') === 'true',
    watermark: textField(parts, 'watermark') === 'true',
  }

  try {
    pruneVideoTasks()
    const handle = await provider.submit(input, AbortSignal.timeout(120_000))
    const id = randomUUID()
    videoTasks.set(id, {
      handle,
      provider,
      model: input.model ?? provider.defaultModel,
      duration: input.duration ?? 5,
      resolution: input.resolution ?? '720p',
      createdAt: Date.now(),
    })
    sendJson(res, 200, { id, status: 'pending' })
  } catch (error) {
    sendJson(res, 502, {
      error: { message: `video submission failed: ${error instanceof Error ? error.message : String(error)}`, type: 'upstream_error' },
    })
  }
}

/** Answer one poll, finishing (and caching) the task the first time it succeeds. */
async function pollVideoTask(ctx: Context, req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const entry = videoTasks.get(id)
  if (entry === undefined) {
    sendJson(res, 404, { error: { message: `unknown video task ${id}`, type: 'invalid_request_error' } })
    return
  }
  if (entry.completed !== undefined) {
    sendJson(res, 200, completedVideoBody(id, entry.completed))
    return
  }
  let poll
  try {
    poll = await entry.handle.poll()
  } catch (error) {
    sendJson(res, 502, {
      error: { message: `video poll failed: ${error instanceof Error ? error.message : String(error)}`, type: 'upstream_error' },
    })
    return
  }
  if (poll.status === 'running') {
    sendJson(res, 200, { id, status: 'pending', ...(poll.progress === undefined ? {} : { progress: poll.progress }) })
    return
  }
  if (poll.status === 'failed') {
    sendJson(res, 200, { id, status: 'failed', error: { message: poll.errorMsg ?? 'video generation failed' } })
    return
  }
  try {
    const result = await entry.provider.finalize(entry.handle)
    const sourceUrl = result.mediaRef.url
    const stable = await downloadToCache({
      url: sourceUrl,
      mediaType: 'video/mp4',
      fallbackExt: 'mp4',
      log: (message) => ctx.logger.warn(`roubaai-media: ${message}`),
    })
    const recorded = await recordCanvasRun({
      ctx,
      req,
      remoteUrl: sourceUrl,
      ext: 'mp4',
      defaultDir: DEFAULT_VIDEO_DIR,
      defaultCategory: DEFAULT_VIDEO_CATEGORY,
      tool: 'video',
      model: result.providerMeta.model,
      providerName: result.providerMeta.provider,
      spec: `${entry.duration}s ${entry.resolution}`,
      costUsd: entry.provider.estimateCostUsd(result.providerMeta.model, entry.duration, entry.resolution) ?? 0,
    })
    entry.completed = {
      url: stable ?? sourceUrl,
      sourceUrl,
      ...(recorded.landed === undefined ? {} : { assetPath: recorded.landed }),
      ledger: recorded.ledger,
    }
    sendJson(res, 200, completedVideoBody(id, entry.completed))
  } catch (error) {
    sendJson(res, 502, {
      error: { message: `video finalize failed: ${error instanceof Error ? error.message : String(error)}`, type: 'upstream_error' },
    })
  }
}

/** Stream the cached copy of a finished video, for the client's content fallback. */
async function serveVideoContent(res: ServerResponse, id: string): Promise<void> {
  const entry = videoTasks.get(id)
  if (entry?.completed === undefined) {
    sendJson(res, 404, { error: { message: `unknown or unfinished video task ${id}`, type: 'invalid_request_error' } })
    return
  }
  const file = cachedMediaFile(entry.completed.sourceUrl)
  if (file === undefined) {
    sendJson(res, 409, { error: { message: 'the finished video has no cached copy to stream', type: 'invalid_request_error' } })
    return
  }
  try {
    const info = await stat(file)
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(info.size), 'accept-ranges': 'none' })
    createReadStream(file).pipe(res)
  } catch {
    sendJson(res, 404, { error: { message: 'the cached video file is gone', type: 'invalid_request_error' } })
  }
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
