import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamBytes, USER_AGENT } from '../src/http.ts'

/** A fake Response exposing a body stream and headers for `streamBytes`. */
function fakeStreamResponse(status: number, bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    headers: new Headers({ 'content-length': String(bytes.byteLength), ...headers }),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('streamBytes', () => {
  it('passes the body stream through verbatim without accumulating bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const upstream = fakeStreamResponse(200, bytes)
    vi.stubGlobal('fetch', vi.fn(async () => upstream))

    const result = await streamBytes('https://cdn.example/v.mp4')

    expect(result).toBeDefined()
    expect(result!.status).toBe(200)

    // The returned stream is the upstream body itself (no buffering), so it
    // yields the exact bytes.
    const reader = result!.stream.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) chunks.push(value)
    }
    const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
    let offset = 0
    for (const c of chunks) { merged.set(c, offset); offset += c.byteLength }
    expect([...merged]).toEqual([...bytes])
  })

  it('forwards a byte range upstream as a Range header', async () => {
    const upstream = fakeStreamResponse(206, new Uint8Array([5, 6]), { 'content-range': 'bytes 4-5/100' })
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => upstream)
    vi.stubGlobal('fetch', fetchMock)

    await streamBytes('https://cdn.example/v.mp4', undefined, { range: 'bytes=4-5' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(init.headers.range).toBe('bytes=4-5')
    expect(init.headers['user-agent']).toBe(USER_AGENT)
  })

  it('returns undefined when the upstream fetch produces no body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, body: null, headers: new Headers() }) as unknown as Response))

    const result = await streamBytes('https://cdn.example/empty.mp4')

    expect(result).toBeUndefined()
  })

  it('forwards the caller signal into the upstream fetch', async () => {
    const upstream = fakeStreamResponse(200, new Uint8Array([7]))
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => upstream)
    vi.stubGlobal('fetch', fetchMock)
    const ac = new AbortController()

    await streamBytes('https://cdn.example/v.mp4', ac.signal)

    const init = fetchMock.mock.calls[0]![1] as { signal: AbortSignal }
    expect(init.signal).toBe(ac.signal)
  })
})
