/**
 * The MxAPI music provider's connection probe. This is the backend whose
 * "Test connection" button read as a bare red failure for a row that had never
 * been given a key, so these specs pin the three states it can report and the
 * evidence each one carries:
 *
 *  - no key anywhere → `unconfigured`, and NO request is made;
 *  - a key that the API rejects → `failed`, carrying MxAPI's own business
 *    message (the only thing that separates "no auth header" from "bad key");
 *  - an endpoint that answers → `ok`.
 *
 * The probe is a read-only `GET /task?id=…`: a connection test must never
 * create a billable generation, which is a defect this button has had before.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MxapiMusicProvider } from '../src/index.ts'

const BASE = 'https://open.mxapi.test/api/v2/music'

/** A fake `fetch` response carrying the MxAPI envelope. */
function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body
    },
  } as unknown as Response
}

/** A context with a credential store seeded (or not) with the MxAPI key. */
function boot(seed?: string): { ctx: Context; calls: Array<{ url: string, method: string }> } {
  const ctx = new Context()
  const calls: Array<{ url: string, method: string }> = []
  ctx.provide('credentials', {
    resolve: async (ref: string) => seed === undefined
      ? undefined
      : { value: seed, source: 'memory', ref },
  })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET' })
    return fakeResponse(200, {})
  })
  return { ctx, calls }
}

/** Stub `fetch` with one response, recording every request. */
function stubFetch(response: Response, calls: Array<{ url: string, method: string }> = []): typeof calls {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET' })
    return response
  })
  return calls
}

function provider(ctx: Context): MxapiMusicProvider {
  return new MxapiMusicProvider(ctx, { baseUrl: BASE })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MxapiMusicProvider probe', () => {
  it('reports unconfigured — and sends nothing — when no key exists anywhere', async () => {
    const { ctx, calls } = boot()
    const result = await provider(ctx).probe({ baseUrl: BASE, apiKey: '' })

    expect(result.status).toBe('unconfigured')
    expect(result.message).toContain('MXAPI_API_KEY')
    // The whole point of the state: nothing was probed, so nothing can fail.
    expect(calls).toHaveLength(0)
  })

  it('treats a whitespace-only draft key as no key at all', async () => {
    const { ctx, calls } = boot()
    const result = await provider(ctx).probe({ baseUrl: BASE, apiKey: '   ' })

    expect(result.status).toBe('unconfigured')
    expect(calls).toHaveLength(0)
  })

  it('reports failed with MxAPI\u2019s own message when the key is rejected', async () => {
    const { ctx } = boot()
    const calls = stubFetch(fakeResponse(401, { code: 401, message: '无效的API密钥' }))
    const result = await provider(ctx).probe({ baseUrl: BASE, apiKey: 'sk-test-bad' })

    expect(result.status).toBe('failed')
    expect(result.message).toContain('401')
    expect(result.message).toContain('无效的API密钥')
    // Read-only by construction: the probe is a task lookup, never a generate.
    expect(calls[0]!.url).toBe(`${BASE}/task?id=connection-probe`)
    expect(calls[0]!.method).toBe('GET')
  })

  it('probes with the saved key when the form holds none', async () => {
    const { ctx } = boot('sk-test-env')
    const calls = stubFetch(fakeResponse(200, { code: 200, data: { task_id: 'connection-probe' } }))
    const result = await provider(ctx).probe({ baseUrl: BASE, apiKey: '' })

    expect(result.status).toBe('ok')
    expect(calls).toHaveLength(1)
  })

  it('accepts a reachable endpoint that answers an unknown task id with a business 404', async () => {
    const { ctx } = boot()
    stubFetch(fakeResponse(404, { code: 404, message: '任务不存在' }))
    await expect(provider(ctx).probe({ baseUrl: BASE, apiKey: 'sk-test-ok' }))
      .resolves.toEqual({ status: 'ok', message: '连接成功（HTTP 404，任务不存在）' })
  })

  it('reports ok on a plain 200', async () => {
    const { ctx } = boot()
    stubFetch(fakeResponse(200, { code: 200, data: {} }))
    await expect(provider(ctx).probe({ baseUrl: BASE, apiKey: 'sk-test-ok' }))
      .resolves.toEqual({ status: 'ok', message: '连接成功（HTTP 200）' })
  })

  it('reports a transport failure as failed, not as unconfigured', async () => {
    const { ctx } = boot()
    vi.stubGlobal('fetch', async () => { throw new Error('connect ECONNREFUSED') })
    const result = await provider(ctx).probe({ baseUrl: BASE, apiKey: 'sk-test-ok' })

    expect(result.status).toBe('failed')
    expect(result.message).toContain('ECONNREFUSED')
  })
})
