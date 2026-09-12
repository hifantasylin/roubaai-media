import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { SaveImageAttachment, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  MaiziImageProvider,
  MaiziVideoProvider,
  ImagePollTimeoutError,
  MissingCredentialError,
} from '../src/index.ts'
import type { VideoGenerateInput } from '@roubaai/media'

/** A fake `fetch` response with the subset of the Response API the http helper uses. */
function fakeResponse(status: number, data: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      // oxlint-disable-next-line typescript/no-unsafe-return -- test fake mirrors Response.json()'s any contract
      return typeof data === 'string' ? JSON.parse(data) : data
    },
    async text() {
      // readJsonBody relies on Response.text(); the fake must mirror it.
      return typeof data === 'string' ? data : JSON.stringify(data)
    },
    async arrayBuffer() {
      const bytes = typeof data === 'string'
        ? new TextEncoder().encode(data)
        : new Uint8Array(data as ArrayBuffer)
      return bytes.buffer
    },
  } as unknown as Response
}

/**
 * A fake Response exposing a `body` ReadableStream and `headers` for the
 * streaming path (`streamBytes`), whose contract reads `response.body` (null →
 * undefined), `response.status`, and `response.headers.get('content-length')`.
 */
function fakeStreamResponse(status: number, bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  const contentLength = String(bytes.byteLength)
  return {
    status,
    ok: status >= 200 && status < 300,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    headers: new Headers({ 'content-length': contentLength, ...headers }),
  } as unknown as Response
}

/** Stub credentials service: resolves a seeded map, records every call. */
class StubCredentials {
  readonly resolve = vi.fn(async (ref: string) => {
    const value = this.seed.get(ref)
    if (value === undefined || value.length === 0) return undefined
    return { value, source: 'memory' }
  })

  constructor(private readonly seed: Map<string, string>) {}
}

/** Stub attachments service: records saveImage calls, returns a canned ref. */
class StubAttachments {
  readonly saves: SaveImageAttachment[] = []
  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saves.push(input)
    return {
      attachmentId: AttachmentId(`sha256:${'f'.repeat(64)}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name !== undefined ? { name: input.name } : {},
    }
  }
}

function boot(seed: Record<string, string> = {}) {
  const ctx = new Context()
  const credentials = new StubCredentials(new Map(Object.entries(seed)))
  const attachments = new StubAttachments()
  ctx.provide('credentials', credentials)
  ctx.provide('attachments', attachments)
  return { ctx, credentials, attachments }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('MaiziImageProvider', () => {
  it('resolves the key per operation and never stores the plaintext key', async () => {
    vi.useFakeTimers()
    const { ctx, credentials } = boot({ MAIZI_API_KEY: 'sk-maizi' })
    const provider = new MaiziImageProvider(ctx)

    // The provider exposes only the reference name, never a plaintext key.
    expect((provider as unknown as Record<string, unknown>).apiKey).toBeUndefined()

    const fetchMock = vi.fn(async (url: string) => {
      const u = url
      if (u.includes('/images/generations')) return fakeResponse(200, { data: [{ task_id: 'img-task-0' }] })
      if (u.includes('/tasks/img-task-0')) {
        return fakeResponse(200, { status: 'completed', data: [{ b64_json: Buffer.from('hello').toString('base64') }] })
      }
      return fakeResponse(200, {})
    })
    vi.stubGlobal('fetch', fetchMock)

    const pending = provider.generate({ prompt: 'a cat' })
    await vi.advanceTimersByTimeAsync(5_000)
    await pending
    expect(credentials.resolve).toHaveBeenCalledTimes(1)
    expect(credentials.resolve).toHaveBeenCalledWith('MAIZI_API_KEY')
  })

  it('lands a completed task with inline b64_json through attachments (never raw base64)', async () => {
    vi.useFakeTimers()
    const { ctx, attachments } = boot({ MAIZI_API_KEY: 'sk-maizi' })
    const provider = new MaiziImageProvider(ctx)

    const b64 = Buffer.from('png-bytes').toString('base64')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = url
      if (u.includes('/images/generations')) return fakeResponse(200, { data: [{ task_id: 'img-task-1' }] })
      if (u.includes('/tasks/img-task-1')) return fakeResponse(200, { status: 'completed', data: [{ b64_json: b64 }] })
      return fakeResponse(200, {})
    }))

    const pending = provider.generate({ prompt: 'a cat' })
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await pending

    expect(result.kind).toBe('image')
    expect(result.attachmentRef).toBe(`sha256:${'f'.repeat(64)}`)
    expect(result.mediaType).toBe('image/png')
    expect(result.providerMeta).toMatchObject({ provider: 'maizi', model: 'gpt-image-2' })

    // The image bytes were persisted, not leaked as base64.
    expect(attachments.saves).toHaveLength(1)
    expect([...attachments.saves[0]!.data]).toEqual([...new TextEncoder().encode('png-bytes')])
  })

  it('lands a completed task with a result url by downloading then saving', async () => {
    vi.useFakeTimers()
    const { ctx, attachments } = boot({ MAIZI_API_KEY: 'sk-maizi' })
    const provider = new MaiziImageProvider(ctx)

    const fetchMock = vi.fn(async (url: string) => {
      const u = url
      if (u.includes('/images/generations')) {
        return fakeResponse(200, { data: [{ task_id: 'img-task-2' }] })
      }
      if (u.includes('/tasks/img-task-2')) {
        return fakeResponse(200, { status: 'completed', result_urls: ['https://cdn.example/img.png'] })
      }
      return fakeStreamResponse(200, new Uint8Array([1, 2, 3]))
    })
    vi.stubGlobal('fetch', fetchMock)

    const pending = provider.generate({ prompt: 'a dog' })
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await pending
    expect(result.attachmentRef).toBe(`sha256:${'f'.repeat(64)}`)
    expect(attachments.saves[0]!.data).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('follows a submit → poll path to completion (fake timers skip the 5s interval)', async () => {
    vi.useFakeTimers()
    const { ctx, attachments } = boot({ MAIZI_API_KEY: 'sk-maizi' })
    const provider = new MaiziImageProvider(ctx)

    const fetchMock = vi.fn(async (url: string) => {
      const u = url
      if (u.includes('/images/generations')) {
        return fakeResponse(200, { task_id: 'img-task-3' })
      }
      if (u.includes('/tasks/img-task-3')) {
        return fakeResponse(200, { status: 'completed', result_urls: ['https://cdn.example/done.png'] })
      }
      return fakeStreamResponse(200, new Uint8Array([9, 9]))
    })
    vi.stubGlobal('fetch', fetchMock)

    const pending = provider.generate({ prompt: 'a slow image' })

    // Advance past the 5s poll interval; then the poll GET + download resolve.
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await pending

    expect(result.attachmentRef).toBe(`sha256:${'f'.repeat(64)}`)
    expect(attachments.saves[0]!.data).toEqual(new Uint8Array([9, 9]))
  })

  it('throws ImagePollTimeoutError carrying the taskId when the 202 poll exceeds the ceiling', async () => {
    const { ctx } = boot({ MAIZI_API_KEY: 'sk-maizi' })
    // pollTimeoutMs 0 makes the deadline immediately expired → no sleep.
    const provider = new MaiziImageProvider(ctx, { pollTimeoutMs: 0 })

    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(202, { task_id: 'img-slow' })))

    const error = await provider.generate({ prompt: 'a slow image' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImagePollTimeoutError)
    expect((error as ImagePollTimeoutError).code).toBe('IMAGE_POLL_TIMEOUT')
    expect((error as ImagePollTimeoutError).taskId).toBe('img-slow')
  })

  it('throws MISSING_CREDENTIAL when the credential resolve returns undefined', async () => {
    const { ctx } = boot() // no key seeded
    const provider = new MaiziImageProvider(ctx)

    const error = await provider.generate({ prompt: 'a cat' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MissingCredentialError)
    expect((error as MissingCredentialError).code).toBe('MISSING_CREDENTIAL')
  })
})

describe('MaiziVideoProvider', () => {
  it('normalizes the Maizi state machine into the abstract poll states', async () => {
    const { ctx } = boot({ MAIZI_API_KEY: 'sk-maizi' })
    const provider = new MaiziVideoProvider(ctx)

    const submitMock = vi.fn(async (_url: string) => fakeResponse(200, { id: 'vid-task-1', status: 'processing' }))
    let taskStatus = 'queued'
    const pollMock = vi.fn(async (_url: string) => fakeResponse(200, { id: 'vid-task-1', status: taskStatus }))
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/videos/generations')) return submitMock(url)
      return pollMock(url)
    }))

    const handle = await provider.submit({ prompt: 'a running horse' })
    expect(handle.taskId).toBe('vid-task-1')

    // queued → running
    expect((await handle.poll()).status).toBe('running')
    // pending → running
    taskStatus = 'pending'
    expect((await handle.poll()).status).toBe('running')
    // processing → running
    taskStatus = 'processing'
    expect((await handle.poll()).status).toBe('running')
  })

  it('maps completed → succeeded (with resultUrl) and failed/violation → failed', async () => {
    const { ctx } = boot({ MAIZI_API_KEY: 'sk-maizi' })
    const provider = new MaiziVideoProvider(ctx)

    const state: { status: string; result_urls?: string[]; error_msg?: string } = {
      status: 'processing',
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/videos/generations')) return fakeResponse(200, { id: 'vid-2', status: 'processing' })
      return fakeResponse(200, { id: 'vid-2', ...state })
    }))

    const handle = await provider.submit({ prompt: 'x' })

    state.status = 'completed'
    state.result_urls = ['https://cdn.example/v.mp4']
    const succeeded = await handle.poll()
    expect(succeeded.status).toBe('succeeded')
    expect(succeeded.resultUrl).toBe('https://cdn.example/v.mp4')
    expect(succeeded.progress).toBe(100)

    state.status = 'failed'
    state.error_msg = 'boom'
    const failed = await handle.poll()
    expect(failed.status).toBe('failed')
    expect(failed.errorMsg).toBe('boom')

    state.status = 'violation'
    state.error_msg = 'content violation'
    const violation = await handle.poll()
    expect(violation.status).toBe('failed')
    expect(violation.errorMsg).toBe('content violation')
  })

  it('finalize probes the result URL and produces a MediaRef (no force-land), recording costUsd in providerMeta', async () => {
    const { ctx } = boot({ MAIZI_API_KEY: 'sk-maizi' })
    const provider = new MaiziVideoProvider(ctx)

    const state: { status: string; result_urls?: string[]; cost?: number } = {
      status: 'processing',
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = url
      if (u.includes('/videos/generations')) return fakeResponse(200, { id: 'vid-3', status: 'processing' })
      if (u.includes('/tasks/vid-3')) return fakeResponse(200, { id: 'vid-3', ...state })
      return fakeStreamResponse(200, new Uint8Array([4, 5, 6]))
    }))

    const handle = await provider.submit({ prompt: 'x' })

    state.status = 'completed'
    state.result_urls = ['https://cdn.example/v3.mp4']
    state.cost = 0.1234

    // finalize polls once more (succeeded) then probes the result URL stream.
    const result = await provider.finalize(handle)

    expect(result.kind).toBe('video')
    expect(result.mediaType).toBe('video/mp4')
    expect(result.providerMeta).toMatchObject({
      provider: 'maizi',
      model: 'doubao-seedance-2.0-mini',
      taskId: 'vid-3',
      costUsd: 0.1234,
    })
    // The result is a unified media reference (streamed on demand), NOT a
    // force-landed local file: the URL is surfaced through `mediaRef`.
    expect(result.attachmentRef).toBeUndefined()
    expect(result.mediaRef).toMatchObject({
      url: 'https://cdn.example/v3.mp4',
      mediaType: 'video/mp4',
      sizeBytes: 3,
    })
    expect(result.mediaRef.expiresAt).toBeGreaterThan(Date.now())
  })

  it('caps reference videos/audio at the Seedance 2.0 limits in the submitted payload (default model 2.0-mini)', async () => {
    const { ctx } = boot({ MAIZI_API_KEY: 'sk-maizi' })
    const provider = new MaiziVideoProvider(ctx)

    let postedBody: unknown
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      postedBody = JSON.parse(init?.body ?? '{}')
      return fakeResponse(200, { id: 'vid-4', status: 'processing' })
    }))

    const input: VideoGenerateInput = {
      prompt: 'a montage',
      videoUrls: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12'],
      audioUrls: ['a1', 'a2', 'a3', 'a4', 'a5'],
      duration: 4,
    }
    await provider.submit(input)

    const body = postedBody as { video_urls?: string[]; audio_urls?: string[] }
    expect(body.video_urls).toHaveLength(3)
    expect(body.audio_urls).toHaveLength(3)
  })

  it('caps reference videos/audio at the Seedance 2.5 limits and passes through new params when the model is 2.5', async () => {
    const { ctx } = boot({ MAIZI_API_KEY: 'sk-maizi' })
    const provider = new MaiziVideoProvider(ctx, { model: 'doubao-seedance-2.5' })

    let postedBody: unknown
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      postedBody = JSON.parse(init?.body ?? '{}')
      return fakeResponse(200, { id: 'vid-25', status: 'processing' })
    }))

    const input: VideoGenerateInput = {
      prompt: 'a montage',
      imageWithRoles: [{ role: 'first_frame', image_url: 'https://cdn/f.png' }],
      videoUrls: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12'],
      audioUrls: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'],
      duration: 4,
      generationType: 'video_edit',
      outputFormat: 'mov',
      callbackUrl: 'https://hook.example/done',
      watermark: false,
    }
    await provider.submit(input)

    const body = postedBody as { model?: string; image_with_roles?: unknown[]; video_urls?: string[]; audio_urls?: string[]; generation_type?: string; output_format?: string; callback_url?: string; watermark?: boolean }
    expect(body.model).toBe('doubao-seedance-2.5')
    expect(body.image_with_roles).toEqual([{ role: 'first_frame', image_url: 'https://cdn/f.png' }])
    expect(body.video_urls).toHaveLength(10)
    expect(body.audio_urls).toHaveLength(10)
    expect(body.generation_type).toBe('video_edit')
    expect(body.output_format).toBe('mov')
    expect(body.callback_url).toBe('https://hook.example/done')
    expect(body.watermark).toBe(false)
  })

  it('throws MISSING_CREDENTIAL when the credential resolve returns undefined', async () => {
    const { ctx } = boot() // no key
    const provider = new MaiziVideoProvider(ctx)

    const error = await provider.submit({ prompt: 'x' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MissingCredentialError)
    expect((error as MissingCredentialError).code).toBe('MISSING_CREDENTIAL')
  })

  it('honors an explicit input.model over the provider default (payload + caps)', async () => {
    const { ctx } = boot({ MAIZI_API_KEY: 'sk-maizi' })
    // provider 默认 2.0-mini，但显式 input.model=2.5 → payload 用 2.5 且按 2.5 上限截断
    const provider = new MaiziVideoProvider(ctx)

    let postedBody: unknown
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      postedBody = JSON.parse(init?.body ?? '{}')
      return fakeResponse(200, { id: 'vid-model', status: 'processing' })
    }))

    await provider.submit({
      prompt: 'a montage',
      model: 'doubao-seedance-2.5',
      videoUrls: Array.from({ length: 12 }, (_, i) => `u${i + 1}`),
      duration: 30,
    })

    const body = postedBody as { model?: string; video_urls?: string[] }
    expect(body.model).toBe('doubao-seedance-2.5')
    expect(body.video_urls).toHaveLength(10)
  })
})
