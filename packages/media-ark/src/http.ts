/**
 * Minimal JSON and result-probe HTTP helper for the Ark adapter, over the
 * global `fetch` (Node's undici). Only the calls this provider makes: create a
 * generation task, poll it, and confirm the produced file is reachable.
 *
 * No third-party runtime dependency: `fetch` is a Node >= 22 global.
 * @module @roubaai/media-ark/http
 */

/** Product identity sent as `User-Agent` (public, non-secret facts only). */
const USER_AGENT = 'roubaai-media-ark (+https://github.com/hifantasylin/roubaai-media)'

/** Raised for an Ark HTTP failure carrying the status and a bounded body snippet. */
export class ArkHttpError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ArkHttpError'
    this.status = status
  }
}

/**
 * Raised for a transport-level failure (DNS, connect, TLS, socket reset) after
 * the retry loop is exhausted. The message always names the stage that failed,
 * so a caller can tell "the provider rejected the request" from "the network
 * dropped before we could ask".
 */
export class ArkNetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ArkNetworkError'
  }
}

/** Whether an error is a transport-level failure rather than an HTTP answer. */
export function isNetworkError(error: unknown): error is ArkNetworkError {
  return error instanceof ArkNetworkError
}

/**
 * Human meaning for the Ark status codes a caller is most likely to act on.
 * Kept to one line each so a job detail stays a single readable line.
 * @param status - the HTTP status, when one was received.
 * @returns the meaning, or a generic rendering.
 */
export function arkStatusMeaning(status: number | undefined): string {
  switch (status) {
    case 400: return '请求参数或模型 ID 无效'
    case 401: return 'API Key 无效或缺失'
    case 403: return 'API Key 无权访问该模型'
    case 404: return '任务不存在'
    case 429: return '请求频率超限或额度不足'
    case 500: return '方舟服务内部错误'
    default: return status === undefined ? '无状态码（网络层失败）' : `HTTP ${status}`
  }
}

/** Render `[status] meaning` when a status is present, else the bare message. */
export function statusTag(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status !== 'number') return ''
  return `[${status}] ${arkStatusMeaning(status)} `
}

/** The vendor's own explanation of a refusal, as Ark nests it in an error body. */
export interface ArkErrorDetail {
  /** Ark's machine-readable code, e.g. `InvalidEndpointOrModel.NotFound`. */
  code?: string
  /** Ark's human-readable explanation, verbatim (Chinese in the cn region). */
  message?: string
}

/**
 * Pull `error.code` / `error.message` out of an Ark error body. Ark is the only
 * authority on why it refused a request, and for a retired model id its code is
 * the whole diagnosis — a generic status mapping would report it as a missing
 * task, which sends a caller looking in the wrong place.
 * @param data - the parsed response body (untrusted).
 * @returns the fields Ark stated, each absent when it stated none.
 */
export function arkErrorDetail(data: unknown): ArkErrorDetail {
  if (typeof data !== 'object' || data === null) return {}
  const error = (data as Record<string, unknown>)['error']
  const source = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : data as Record<string, unknown>
  const code = typeof source['code'] === 'string' && source['code'].length > 0 ? source['code'] : undefined
  const message = typeof source['message'] === 'string' && source['message'].length > 0 ? source['message'] : undefined
  return {
    ...code === undefined ? {} : { code },
    ...message === undefined ? {} : { message },
  }
}

/** Whether an Ark refusal names a model id or endpoint Ark no longer serves. */
export function isModelNotFound(status: number | undefined, detail: ArkErrorDetail): boolean {
  if (detail.code !== undefined && /InvalidEndpointOrModel|ModelNotFound|InvalidModel/i.test(detail.code)) return true
  return status === 404
}

/** Number of attempts for transient network retries (timeouts, 5xx). */
const RETRY_ATTEMPTS = 3

/** Backoff base in milliseconds between transient retries. */
const RETRY_BASE_MS = 500

/** Request headers: JSON content type plus the Ark bearer credential. */
export function arkHeaders(apiKey: string): Record<string, string> {
  return {
    'authorization': `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
  }
}

/** True when the error is the caller's abort rather than a request failure. */
function isAbort(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError'
}

/** Wrap any non-abort, non-HTTP `fetch` failure into an {@link ArkNetworkError}. */
function wrapFetchError(stage: string, error: unknown): unknown {
  if (isAbort(error) || error instanceof ArkHttpError || error instanceof ArkNetworkError) return error
  const causeText = error instanceof Error ? error.message : String(error)
  return new ArkNetworkError(`${stage} (network): ${causeText}`, error)
}

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
    const onAbort = (): void => {
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
 * Read a response body as JSON, falling back to a bounded raw snippet when the
 * body is not JSON (a gateway may answer a 4xx with HTML). Returning the
 * snippet keeps a failure diagnosable without turning a parse error into a
 * transient retry.
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

/**
 * POST a JSON body and parse the JSON response, retrying transient failures
 * (network errors and 5xx). A 4xx returns the status without retrying so Ark's
 * own validation errors surface immediately.
 * @param url - the absolute endpoint.
 * @param apiKey - the Ark API key to present.
 * @param body - the JSON-serializable request body.
 * @param signal - cancellation forwarded to `fetch`.
 * @returns the status and parsed body.
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
        headers: arkHeaders(apiKey),
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
      const status = response.status
      if (status >= 500) {
        lastError = new ArkHttpError(`Ark upstream error [${status}]`, status)
        if (!isLast) await sleep(RETRY_BASE_MS * 2 ** attempt, signal)
        continue
      }
      return { status, data: await readJsonBody(response, status) }
    } catch (error) {
      if (isAbort(error)) throw error
      lastError = wrapFetchError('Ark request', error)
      if (!isLast) await sleep(RETRY_BASE_MS * 2 ** attempt, signal)
    }
  }
  throw lastError instanceof Error ? lastError : new ArkHttpError('Ark request failed after retries')
}

/**
 * GET a JSON response, retrying transient failures. Used to poll task state.
 * @param url - the absolute endpoint.
 * @param apiKey - the Ark API key to present.
 * @param signal - cancellation forwarded to `fetch`.
 * @returns the status and parsed body.
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
        headers: arkHeaders(apiKey),
        ...(signal !== undefined ? { signal } : {}),
      })
      const status = response.status
      if (status >= 500) {
        lastError = new ArkHttpError(`Ark upstream error [${status}]`, status)
        if (!isLast) await sleep(RETRY_BASE_MS * 2 ** attempt, signal)
        continue
      }
      return { status, data: await readJsonBody(response, status) }
    } catch (error) {
      if (isAbort(error)) throw error
      lastError = wrapFetchError('Ark poll', error)
      if (!isLast) await sleep(RETRY_BASE_MS * 2 ** attempt, signal)
    }
  }
  throw lastError instanceof Error ? lastError : new ArkHttpError('Ark request failed after retries')
}

/** What a result-URL probe reports: reachability, plus the size when stated. */
export interface ResultProbe {
  status: number
  /** Total byte size from `content-length`, when the CDN states one. */
  sizeBytes?: number
}

/**
 * Confirm a produced file is reachable and read its stated size, then cancel
 * the body: the bytes themselves flow through the host's media proxy when the
 * user plays or downloads the asset, so holding them here would only buffer a
 * whole video for a `content-length` header.
 * @param url - the result URL to probe.
 * @param signal - cancellation forwarded to `fetch`.
 * @returns the probe outcome, or `undefined` when the upstream produced no body.
 */
export async function probeResult(url: string, signal?: AbortSignal): Promise<ResultProbe | undefined> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT },
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error) {
    throw wrapFetchError('result probe', error)
  }
  if (response.body === null) return { status: response.status }
  await response.body.cancel().catch(() => {})
  const contentLength = Number(response.headers.get('content-length'))
  const sizeBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined
  return { status: response.status, ...(sizeBytes === undefined ? {} : { sizeBytes }) }
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
 * `arrayBuffer`, so a large result survives a slow CDN connection) and
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
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error) {
    throw wrapFetchError('Ark download', error)
  }
  if (!response.ok) {
    throw new ArkHttpError(`Ark download failed [${response.status}]`, response.status)
  }
  if (response.body === null) {
    throw new ArkHttpError('Ark download: response body is empty (no stream)')
  }
  const contentLength = Number(response.headers.get('content-length'))
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    // Distinguish a genuine end-of-stream (`{done:true}`) from an inactivity
    // timeout: the timeout branch must throw so the caller retries instead of
    // landing a partial file as if it were the complete body.
    const read = reader.read()
    const timer = cancellableSleep(options.inactivityTimeoutMs, signal)
    const outcome = await Promise.race([
      read.then((): 'read' => 'read'),
      timer.promise.then((): 'timeout' => 'timeout'),
    ])
    if (outcome === 'timeout') {
      // The `read` promise is still pending; it settles when the stream sends a
      // chunk or ends. Throw without awaiting it so the timeout surfaces now.
      throw new ArkHttpError(
        `Ark download inactivity timeout after ${options.inactivityTimeoutMs}ms (${received}/${totalBytes ?? '?'} bytes)`,
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
      throw new ArkHttpError(`Ark download exceeds ${options.maxBytes} bytes`)
    }
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (options.minBytes !== undefined && bytes.byteLength < options.minBytes) {
    throw new ArkHttpError(`Ark download truncated: expected ≥ ${options.minBytes} bytes, got ${bytes.byteLength}`)
  }
  return bytes
}

/**
 * Download a URL into raw bytes (a generated image, before it is handed to the
 * attachment store), streaming the body and verifying size bounds, with
 * transient-failure retry. The caller owns `maxBytes`; providers pass
 * `minBytes` and an inactivity timeout so a truncated download is retried
 * rather than landed as a corrupt file.
 * @param url - the result URL to fetch.
 * @param signal - cancellation forwarded to `fetch`.
 * @param options - size bounds, inactivity timeout, and the progress callback.
 * @returns the complete body bytes.
 * @throws {ArkHttpError} on a non-2xx answer or a violated size bound.
 * @throws {ArkNetworkError} when the transport fails after every retry.
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
  throw lastError instanceof Error ? lastError : new ArkHttpError('Ark download failed after retries')
}
