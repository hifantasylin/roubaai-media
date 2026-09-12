/**
 * Ark adapter behavior: the request it builds, the status vocabulary it
 * normalizes, and the result it lands. Ark speaks a different protocol from the
 * Maizi backend, so these specs pin the mapping rather than a shared shape.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ArkVideoProvider, MissingCredentialError } from '../src/index.ts'
import type { VideoTaskHandle } from '@roubaai/media'

const BASE = 'https://ark.example/api/v3'

/** A fake `fetch` response with the subset of the Response API the http helper uses. */
function fakeResponse(status: number, data: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return JSON.stringify(data)
    },
  } as unknown as Response
}

/** A fake response for the result probe: a cancellable body plus a stated size. */
function fakeProbeResponse(status: number, sizeBytes?: number): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    body: { cancel: async () => {} },
    headers: new Headers(sizeBytes === undefined ? {} : { 'content-length': String(sizeBytes) }),
  } as unknown as Response
}

/** One recorded request. */
interface RecordedCall {
  url: string
  body: unknown
  authorization: string | undefined
}

/** Stub `fetch` with a fixed sequence of responses, recording every request. */
function stubFetch(responses: Array<() => Response>, calls: RecordedCall[] = []): RecordedCall[] {
  let index = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: (init.headers as Record<string, string> | undefined)?.['authorization'],
    })
    const next = responses[Math.min(index, responses.length - 1)]!
    index++
    return next()
  })
  return calls
}

/** A context whose credentials service resolves the given key. */
function contextWithKey(key = 'ark-key'): Context {
  const ctx = new Context()
  ctx.provide('credentials', {
    resolve: async () => ({ value: key, source: 'memory' }),
  })
  return ctx
}

function provider(ctx: Context): ArkVideoProvider {
  return new ArkVideoProvider(ctx, { baseUrl: BASE })
}

/** Submit one task against a stubbed creation call and return the handle. */
async function submitted(ctx: Context): Promise<VideoTaskHandle> {
  stubFetch([() => fakeResponse(200, { id: 'task-42' })])
  return await provider(ctx).submit({ prompt: 'a red panda', model: 'doubao-seedance-1-5-pro-251215' })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ArkVideoProvider caps', () => {
  it('reads the generation out of the model id', () => {
    const instance = provider(contextWithKey())
    expect(instance.caps('doubao-seedance-2-5-pro')).toMatchObject({ maxDuration: 30, maxVideoUrls: 10 })
    expect(instance.caps('doubao-seedance-2-0-pro')).toMatchObject({ maxDuration: 15, maxVideoUrls: 3 })
    expect(instance.caps('doubao-seedance-1-5-pro-251215')).toMatchObject({ maxDuration: 12, maxVideoUrls: 0 })
  })

  it('falls back to the conservative set for an id it cannot place', () => {
    const instance = provider(contextWithKey())
    expect(instance.caps('some-unknown-model')).toMatchObject({ minDuration: 2, maxDuration: 12, maxImageUrls: 2 })
  })
})

describe('ArkVideoProvider pricing', () => {
  it('states no USD figure: Ark bills in RMB', () => {
    expect(provider(contextWithKey()).estimateCostUsd('doubao-seedance-1-5-pro-251215', 5, '720p')).toBeUndefined()
  })
})

describe('ArkVideoProvider submit', () => {
  it('posts a content array to the task endpoint with the bearer key', async () => {
    const calls = stubFetch([() => fakeResponse(200, { id: 'task-42' })])
    const handle = await provider(contextWithKey()).submit({
      prompt: 'a red panda',
      model: 'doubao-seedance-1-5-pro-251215',
      imageUrls: ['https://cdn/first.png'],
      duration: 5,
      size: '16:9',
      resolution: '720p',
      generateAudio: true,
    })

    expect(handle.taskId).toBe('task-42')
    expect(calls[0]!.url).toBe(`${BASE}/contents/generations/tasks`)
    expect(calls[0]!.authorization).toBe('Bearer ark-key')
    expect(calls[0]!.body).toMatchObject({
      model: 'doubao-seedance-1-5-pro-251215',
      duration: 5,
      // The seam's `size` is Ark's `ratio`.
      ratio: '16:9',
      resolution: '720p',
      generate_audio: true,
      content: [
        { type: 'text', text: 'a red panda' },
        { type: 'image_url', image_url: { url: 'https://cdn/first.png' }, role: 'first_frame' },
      ],
    })
  })

  it('places several unroled images as reference images and keeps explicit roles verbatim', async () => {
    const calls = stubFetch([() => fakeResponse(200, { id: 't' })])
    await provider(contextWithKey()).submit({
      prompt: 'two shots',
      model: 'doubao-seedance-2-5-pro',
      imageUrls: ['https://cdn/a.png', 'https://cdn/b.png'],
    })
    const content = (calls[0]!.body as { content: unknown[] }).content
    expect(content).toMatchObject([
      { type: 'text' },
      { type: 'image_url', image_url: { url: 'https://cdn/a.png' }, role: 'reference_image' },
      { type: 'image_url', image_url: { url: 'https://cdn/b.png' }, role: 'reference_image' },
    ])

    const tagged = stubFetch([() => fakeResponse(200, { id: 't2' })])
    await provider(contextWithKey()).submit({
      prompt: 'a handover',
      model: 'doubao-seedance-2-5-pro',
      imageWithRoles: [
        { role: 'first_frame', image_url: 'https://cdn/first.png' },
        { role: 'last_frame', image_url: { url: 'https://cdn/last.png' } },
      ],
    })
    expect((tagged[0]!.body as { content: unknown[] }).content).toMatchObject([
      { type: 'text' },
      { type: 'image_url', image_url: { url: 'https://cdn/first.png' }, role: 'first_frame' },
      { type: 'image_url', image_url: { url: 'https://cdn/last.png' }, role: 'last_frame' },
    ])
  })

  it('maps an explicit video-edit request onto Ark\u2019s task-type hint', async () => {
    const calls = stubFetch([() => fakeResponse(200, { id: 't' })])
    await provider(contextWithKey()).submit({
      prompt: 'make it night',
      model: 'doubao-seedance-2-5-pro',
      videoUrls: ['https://cdn/in.mp4'],
      generationType: 'video_edit',
      size: 'adaptive',
    })
    expect(calls[0]!.body).toMatchObject({
      ratio: 'adaptive',
      omni_reference_task_type: 'edit',
      content: [
        { type: 'text' },
        { type: 'video_url', video_url: { url: 'https://cdn/in.mp4' }, role: 'reference_video' },
      ],
    })
  })

  it('fails loudly when no key is configured', async () => {
    const ctx = new Context()
    stubFetch([() => fakeResponse(200, { id: 't' })])
    await expect(provider(ctx).submit({ prompt: 'x', model: 'm' }))
      .rejects.toBeInstanceOf(MissingCredentialError)
  })
})

describe('ArkVideoProvider polling', () => {
  it('keeps the task running while Ark queued or running', async () => {
    const ctx = contextWithKey()
    const handle = await submitted(ctx)
    stubFetch([() => fakeResponse(200, { id: 'task-42', status: 'running' })])
    await expect(handle.poll()).resolves.toEqual({ status: 'running' })
    stubFetch([() => fakeResponse(200, { id: 'task-42', status: 'queued' })])
    await expect(handle.poll()).resolves.toEqual({ status: 'running' })
  })

  it('surfaces the produced video URL on success', async () => {
    const ctx = contextWithKey()
    const handle = await submitted(ctx)
    stubFetch([() => fakeResponse(200, {
      id: 'task-42',
      status: 'succeeded',
      content: { video_url: 'https://cdn/v.mp4' },
    })])
    await expect(handle.poll()).resolves.toEqual({
      status: 'succeeded',
      progress: 100,
      resultUrl: 'https://cdn/v.mp4',
    })
  })

  it('treats expired as a failure and reports Ark\u2019s reason', async () => {
    const ctx = contextWithKey()
    const handle = await submitted(ctx)
    stubFetch([() => fakeResponse(200, { id: 'task-42', status: 'expired' })])
    await expect(handle.poll()).resolves.toEqual({
      status: 'failed',
      errorMsg: 'Ark task task-42 failed (expired)',
    })

    stubFetch([() => fakeResponse(200, {
      id: 'task-42',
      status: 'failed',
      error: { code: 'InvalidParameter', message: '内容不合规' },
    })])
    await expect(handle.poll()).resolves.toEqual({ status: 'failed', errorMsg: '内容不合规' })
  })

  it('fails a deterministic client error immediately instead of polling it out', async () => {
    const ctx = contextWithKey()
    const handle = await submitted(ctx)
    stubFetch([() => fakeResponse(401, { error: { message: 'bad key' } })])
    const poll = await handle.poll()
    expect(poll.status).toBe('failed')
    expect(poll.errorMsg).toMatch(/API Key/)
  })
})

describe('ArkVideoProvider finalize', () => {
  it('probes the result URL and lands a media reference', async () => {
    const ctx = contextWithKey()
    const handle = await submitted(ctx)
    stubFetch([
      () => fakeResponse(200, {
        id: 'task-42',
        status: 'succeeded',
        content: { video_url: 'https://cdn/v.mp4' },
      }),
      () => fakeProbeResponse(200, 4096),
    ])

    const result = await provider(ctx).finalize(handle)
    expect(result.mediaType).toBe('video/mp4')
    expect(result.mediaRef).toMatchObject({
      url: 'https://cdn/v.mp4',
      mediaType: 'video/mp4',
      sizeBytes: 4096,
    })
    expect(result.providerMeta).toMatchObject({
      provider: 'ark',
      model: 'doubao-seedance-1-5-pro-251215',
      taskId: 'task-42',
    })
  })

  it('refuses an unreachable result URL', async () => {
    const ctx = contextWithKey()
    const handle = await submitted(ctx)
    stubFetch([
      () => fakeResponse(200, {
        id: 'task-42',
        status: 'succeeded',
        content: { video_url: 'https://cdn/gone.mp4' },
      }),
      () => fakeProbeResponse(404),
    ])
    await expect(provider(ctx).finalize(handle)).rejects.toThrow(/unreachable/)
  })
})
