/**
 * The route's own (generic) probes: what runs when the row's adapter cannot
 * answer for itself — it is not mounted, or it implements no probe of its own.
 *
 * These are the probes that used to answer a bare boolean, which is how a row
 * with no key at all ended up showing the same red as a row whose key the
 * vendor rejected. They now report three states, and each spec here pins one:
 * nothing configured, configured but refused, configured and reachable — plus
 * the music path, whose API explains a refusal in its own words.
 *
 * Neither probe may ever create a billable generation: the OpenAI-compatible
 * one reads `GET /models`, the music one looks up a task id that cannot exist.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { testConnection, testMusicConnection } from '../src/index.ts'

const BASE = 'https://backend.example/v1'

/** A fake `fetch` response carrying a JSON body. */
function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body
    },
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('testConnection', () => {
  it('reports unconfigured — and sends nothing — with no key', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    const result = await testConnection(BASE, '   ')

    expect(result.status).toBe('unconfigured')
    expect(result.message).toContain('API Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports failed with the status when the key is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(401, {})))
    const result = await testConnection(BASE, 'sk-test-bad')

    expect(result.status).toBe('failed')
    expect(result.message).toContain('401')
  })

  it('reports ok when the endpoint answers', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return fakeResponse(200, {})
    }))

    await expect(testConnection(BASE, 'sk-test-ok'))
      .resolves.toEqual({ status: 'ok', message: '连接成功（HTTP 200）' })
    // Read-only: the probe asks for the model list, never for a generation.
    expect(calls[0]).toBe(`${BASE}/models`)
  })

  it('reports a transport failure as failed, not as unconfigured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed') }))
    const result = await testConnection(BASE, 'sk-test-ok')

    expect(result.status).toBe('failed')
    expect(result.message).toContain('fetch failed')
  })
})

describe('testMusicConnection', () => {
  it('reports unconfigured — and sends nothing — with no key', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200, {}))
    vi.stubGlobal('fetch', fetchMock)

    const result = await testMusicConnection('https://open.mxapi.test/api/v2/music', '')

    expect(result.status).toBe('unconfigured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('carries MxAPI\u2019s own message when the key is rejected', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return fakeResponse(401, { code: 401, message: '无效的API密钥' })
    }))

    const result = await testMusicConnection('https://open.mxapi.test/api/v2/music', 'sk-test-bad')

    expect(result.status).toBe('failed')
    expect(result.message).toContain('401')
    expect(result.message).toContain('无效的API密钥')
    // Read-only by construction: a task lookup, never a generate call.
    expect(calls[0]).toBe('https://open.mxapi.test/api/v2/music/task?id=connection-probe')
  })

  it('reports ok on a business 404 for the probe task id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(404, { code: 404, message: '任务不存在' })))
    await expect(testMusicConnection('https://open.mxapi.test/api/v2/music', 'sk-test-ok'))
      .resolves.toEqual({ status: 'ok', message: '连接成功（HTTP 404，任务不存在）' })
  })
})
