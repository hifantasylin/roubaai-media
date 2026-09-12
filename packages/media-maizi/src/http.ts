/**
 * Minimal JSON/binary HTTP helper over the global `fetch` (Node's built-in
 * undici). Shared by the Maizi image and video providers for the two endpoints
 * they call, with per-request attribution (`User-Agent`) and a small retry
 * loop over transient network failures.
 *
 * No third-party runtime dependency: `fetch` is a Node ≥22 global.
 *
 * @module @roubaai/media-maizi/http
 */

import { createRequire } from 'node:module'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/** Product identity sent as `User-Agent` (public, non-secret facts only). */
export const USER_AGENT = `deepseek-harness/${version} (+https://github.com/deepseek-ai/deepseek-harness)`

/** Raised for a provider HTTP failure carrying the status and a bounded body snippet. */
export class MaiziHttpError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'MaiziHttpError'
    this.status = status
  }
}

/**
 * Raised for a transport-level failure (DNS, connect, TLS, socket reset —
 * whatever the runtime surfaces as a bare `TypeError: fetch failed`) AFTER the
 * retry loop has been exhausted. The message always carries the stage that
 * failed and the underlying cause, so callers and the LLM can tell "the
 * provider rejected the request" from "the network dropped before we could
 * ask", and can tell "generation failed" from "the result could not be
 * downloaded".
 */
export class MaiziNetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MaiziNetworkError'
  }
}

/** True when the error is a transport-level failure (not an abort, not an HTTP status). */
export function isNetworkError(error: unknown): error is MaiziNetworkError {
  return error instanceof MaiziNetworkError
}

/**
 * Human meaning for the Maizi/upstream HTTP status codes the LLM is most
 * likely to act on. Kept on one line each so the job detail stays a single
 * readable line with the code embedded, e.g. `[402] 余额不足，请充值后再试`.
 */
export function httpStatusMeaning(status: number | undefined): string {
  switch (status) {
    case 200: return '请求成功'
    case 400: return '模型不可用或未配置价格'
    case 401: return 'API Key 无效或缺失'
    case 402: return '余额不足，请充值后再试'
    case 404: return '任务不存在'
    case 422: return '请求参数校验失败'
    case 429: return '请求频率超限或 Coding Plan 额度不足'
    case 500: return '服务器内部错误'
    default: return status === undefined ? '无状态码（网络层失败）' : `HTTP ${status}`
  }
}

/** Pull the HTTP status off an error when it carries one (MaiziHttpError does). */
export function errorStatus(error: unknown): number | undefined {
  return (error as { status?: unknown } | null)?.status === undefined
    ? undefined
    : Number((error as { status?: unknown } | null)?.status)
}

/** Render `[status] meaning` when a status is present, else the bare message. */
export function statusTag(error: unknown): string {
  const status = errorStatus(error)
  return status === undefined ? '' : `[${status}] ${httpStatusMeaning(status)} `
}

/** Wrap any non-abort, non-HTTP error thrown by a `fetch` into a {@link MaiziNetworkError}. */
function wrapFetchError(stage: string, error: unknown): unknown {
  if (isAbort(error) || error instanceof MaiziHttpError || error instanceof MaiziNetworkError) return error
  const causeText = error instanceof Error ? error.message : String(error)
  return new MaiziNetworkError(`${stage} (network): ${causeText}`, error)
}

/** Number of attempts for transient network retries (timeouts, 5xx). */
const RETRY_ATTEMPTS = 3

/** Backoff base in milliseconds between transient retries. */
const RETRY_BASE_MS = 500

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal === undefined) {
      setTimeout(resolve, ms)
      return
    }
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Like {@link sleep}, but its timeout is cancellable: it returns a handle whose
 * `clear()` releases the timer and abort listener so a caller that won the
 * `Promise.race` does not leave a dangling inactivity timer per chunk.
 */
function cancellableSleep(ms: number, signal?: AbortSignal): { promise: Promise<void>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const promise = new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    onAbort = () => {
      if (timer !== undefined) clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort as () => void)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  return {
    promise,
    clear: () => {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', onAbort)
    },
  }
}

/** Build the common request headers: JSON content type + attribution. */
export function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    'authorization': `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
  }
}

/** True when the error is an abort (the caller's signal fired). */
function isAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError'
}

/**
 * POST a JSON body and parse the JSON response, retrying transient failures
 * (network errors and 5xx) up to {@link RETRY_ATTEMPTS} times. A 4xx returns
 * the status without retrying so the provider's own validation errors surface
 * immediately.
 */
export async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; data: unknown }> {
  let lastError: unknown
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    const isLast = attempt === RETRY_ATTEMPTS - 1
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: jsonHeaders(apiKey),
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
      const status = response.status
      if (status >= 500) {
        lastError = new MaiziHttpError(`Maizi upstream error [${status}]`, status)
        if (!isLast) await sleep(RETRY_BASE_MS * 2 ** attempt, signal)
        continue
      }
      // A 4xx is a definitive answer (validation error) — surface it, even when
      // the body is not JSON, instead of treating a JSON-parse failure as a
      // transient network error and retrying.
      const data = await readJsonBody(response, status)
      return { status, data }
    } catch (error) {
      if (isAbort(error)) throw error
      lastError = wrapFetchError('Maizi request', error)
      if (!isLast) await sleep(RETRY_BASE_MS * 2 ** attempt, signal)
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new MaiziHttpError('Maizi request failed after retries')
}

/**
 * GET a JSON response, retrying transient failures. Used for polling task
 * state (`GET /v1/tasks/{id}` and the image v2 202 poll path).
 */
export async function getJson(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ status: number; data: unknown }> {
  let lastError: unknown
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    const isLast = attempt === RETRY_ATTEMPTS - 1
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: jsonHeaders(apiKey),
        ...signal !== undefined ? { signal } : {},
      })
      const status = response.status
      if (status >= 500) {
        lastError = new MaiziHttpError(`Maizi upstream error [${status}]`, status)
        if (!isLast) await sleep(RETRY_BASE_MS * 2 ** attempt, signal)
        continue
      }
      const data = await readJsonBody(response, status)
      return { status, data }
    } catch (error) {
      if (isAbort(error)) throw error
      lastError = wrapFetchError('Maizi poll', error)
      if (!isLast) await sleep(RETRY_BASE_MS * 2 ** attempt, signal)
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new MaiziHttpError('Maizi request failed after retries')
}

/**
 * Read a response body as JSON, falling back to a bounded raw snippet when the
 * body is not valid JSON (a gateway may answer a 4xx with HTML). Returning the
 * snippet keeps the failure diagnosable without letting a parse error escape
 * into the transient-retry path.
 */
async function readJsonBody(response: Response, status: number): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text
    return { error: `non-JSON response body [${status}]`, snippet }
  }
}

/** Download options: size bounds and an inactivity timeout. */
export interface DownloadOptions {
  /** Refuse a response body larger than this many bytes. */
  maxBytes?: number
  /** Require the downloaded body to be at least this many bytes (catches truncated downloads). */
  minBytes?: number
  /** Inactivity (no chunk received) timeout in ms; resets on each chunk. */
  inactivityTimeoutMs?: number
  /**
   * Optional progress callback fired on each received chunk with the running
   * received byte count and the total expected bytes (from `content-length`,
   * which may be absent). Lets a caller surface real download progress.
   */
  onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void
}

/** Default inactivity timeout: 5 minutes without a chunk aborts the download. */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000

/**
 * Download one response body into raw bytes, streaming chunks (not one-shot
 * `arrayBuffer`, so large files like videos survive slow CDN connections) and
 * enforcing a per-chunk inactivity timeout plus size bounds.
 */
async function downloadOnce(
  url: string,
  signal: AbortSignal | undefined,
  options: {
    maxBytes: number | undefined
    minBytes: number | undefined
    inactivityTimeoutMs: number
    onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void
  },
): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT },
      ...signal !== undefined ? { signal } : {},
    })
  } catch (error) {
    throw wrapFetchError('download', error)
  }
  if (!response.ok) {
    throw new MaiziHttpError(`download failed [${response.status}]`, response.status)
  }
  if (response.body === null) {
    throw new MaiziHttpError('download: response body is empty (no stream)')
  }
  const contentLength = Number(response.headers.get('content-length'))
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined
  const reader = response.body.getReader()
  // Accumulate into one preallocated buffer when the total is known, avoiding
  // the 2× peak memory of keeping every chunk and copying once at the end.
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    // Distinguish a genuine end-of-stream (`reader.read()` → `{done:true}`)
    // from an inactivity timeout: the timeout branch must throw so the caller
    // retries instead of silently landing a partial file as if it were the
    // complete body.
    const read = reader.read()
    const timer = cancellableSleep(options.inactivityTimeoutMs, signal)
    const outcome = await Promise.race([
      read.then((): 'read' => 'read'),
      timer.promise.then((): 'timeout' => 'timeout'),
    ])
    if (outcome === 'timeout') {
      // The `read` promise is still pending; it resolves when the stream sends
      // a chunk or ends. We throw without awaiting it so the timeout is
      // surfaced now; the pending read is dropped with the reader's stream.
      throw new MaiziHttpError(
        `download inactivity timeout after ${options.inactivityTimeoutMs}ms (${received}/${totalBytes ?? '?'} bytes)`,
      )
    }
    // The chunk won the race — release the inactivity timer so no dangling
    // timer/listener is left behind per chunk.
    timer.clear()
    const { done, value } = await read
    if (done) break
    const chunk = value
    chunks.push(chunk)
    received += chunk.byteLength
    options.onProgress?.(received, totalBytes)
    if (options.maxBytes !== undefined && received > options.maxBytes) {
      throw new MaiziHttpError(`download exceeds ${options.maxBytes} bytes`)
    }
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (options.minBytes !== undefined && bytes.byteLength < options.minBytes) {
    throw new MaiziHttpError(`download truncated: expected ≥ ${options.minBytes} bytes, got ${bytes.byteLength}`)
  }
  return bytes
}

/**
 * Download a URL into raw bytes (the 24h-valid result file), streaming the
 * body and verifying size bounds, with transient-failure retry. The caller
 * owns `maxBytes`; providers pass `minBytes` (e.g. a video floor) and an
 * inactivity timeout so a truncated download is retried rather than landed as
 * a corrupt file.
 */
export async function downloadBytes(
  url: string,
  signal?: AbortSignal,
  options?: DownloadOptions,
): Promise<Uint8Array> {
  const resolved: {
    maxBytes: number | undefined
    minBytes: number | undefined
    inactivityTimeoutMs: number
    onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void
  } = {
    maxBytes: options?.maxBytes,
    minBytes: options?.minBytes,
    inactivityTimeoutMs: options?.inactivityTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    ...options?.onProgress === undefined ? {} : { onProgress: options.onProgress },
  }
  let lastError: unknown
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await downloadOnce(url, signal, resolved)
    } catch (error) {
      if (isAbort(error)) throw error
      lastError = error
      // No point backing off after the final attempt.
      if (attempt < RETRY_ATTEMPTS - 1) await sleep(RETRY_BASE_MS * 2 ** attempt, signal)
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new MaiziHttpError('download failed after retries')
}

/** Stream options: optional byte range passthrough for the CDN. */
export interface StreamOptions {
  /** Optional `Range: bytes=start-end` header value to forward upstream. */
  range?: string
}

/**
 * Open a streaming read of a URL and return its body as a `ReadableStream` of
 * byte chunks — the passthrough seam for the host media proxy. Unlike
 * {@link downloadBytes}, the bytes are NOT accumulated: the returned stream is
 * handed straight to a `Response`, so the CDN's own stream (and, when the CDN
 * supports `Accept-Ranges`, its range responses) reaches the consumer
 * incrementally — enabling progressive image display and video "play while
 * downloading". A non-2xx upstream answers `undefined` so the caller can map
 * the failure (e.g. an expired 24h URL → 410) rather than treat it as bytes.
 *
 * @param url - the 24h-valid result URL to stream.
 * @param signal - cancellation forwarded to the upstream `fetch`; aborts the
 * returned stream.
 * @param options - optional byte-range passthrough.
 * @returns the upstream body stream, or `undefined` when the upstream fetch
 * fails before the body is produced (caller inspects status/headers).
 */
export async function streamBytes(
  url: string,
  signal?: AbortSignal,
  options?: StreamOptions,
): Promise<{ stream: ReadableStream<Uint8Array>; status: number; headers: Headers } | undefined> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'user-agent': USER_AGENT,
        ...options?.range !== undefined ? { range: options.range } : {},
      },
      ...signal !== undefined ? { signal } : {},
    })
  } catch (error) {
    throw wrapFetchError('stream', error)
  }
  if (response.body === null) {
    return undefined
  }
  return { stream: response.body, status: response.status, headers: response.headers }
}
