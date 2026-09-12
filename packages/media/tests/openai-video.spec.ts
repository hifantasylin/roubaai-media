import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MediaRuntimeLocal, VideoProvider } from '../src/index.ts'
import type { ProviderProbeResult, VideoCaps, VideoGenerateInput, VideoGenerationResult, VideoTaskHandle, VideoTaskPoll } from '../src/index.ts'
import { OPENAI_FACADE_PREFIX, handleOpenAiRequest } from '../src/openai-facade.ts'
import { registerLocalMedia } from '../src/media-cache.ts'
import { boundaryOf, fileFields, parseMultipart, textField } from '../src/multipart.ts'

const VIDEOS = `${OPENAI_FACADE_PREFIX}/v1/videos`

/** A video provider that reports running once, then succeeds. */
class StubVideoProvider extends VideoProvider {
  readonly provider = 'stub-video'
  readonly defaultModel = 'stub-video-v1'
  inputs: VideoGenerateInput[] = []
  polls = 0
  resultUrl = 'https://cdn.example/clip.mp4'
  async submit(input: VideoGenerateInput): Promise<VideoTaskHandle> {
    this.inputs.push(input)
    const self = this
    return {
      taskId: 'task-1',
      async poll(): Promise<VideoTaskPoll> {
        self.polls += 1
        return self.polls < 2 ? { status: 'running', progress: 10 } : { status: 'succeeded', resultUrl: self.resultUrl }
      },
    }
  }
  async finalize(): Promise<VideoGenerationResult> {
    return {
      kind: 'video',
      mediaType: 'video/mp4',
      mediaRef: { url: this.resultUrl, mediaType: 'video/mp4', expiresAt: Date.now() + 86_400_000 },
      providerMeta: { provider: this.provider, model: this.defaultModel, taskId: 'task-1' },
    }
  }
  caps(): VideoCaps {
    return { minDuration: 4, maxDuration: 15, maxImageUrls: 9, maxVideoUrls: 3, maxAudioUrls: 3 }
  }
  estimateCostUsd(): number | undefined {
    return undefined
  }
  async probe(): Promise<ProviderProbeResult> {
    return { status: 'ok', message: 'stub' }
  }
  async testConnection(): Promise<boolean> {
    return true
  }
}

let scratch = ''
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'roubaai-video-'))
})
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function boot(options: { normalizer?: boolean } = {}): Promise<{ ctx: Context; provider: StubVideoProvider }> {
  const ctx = new Context()
  new MediaRuntimeLocal(ctx)
  if (options.normalizer === true) {
    // Stands in for the reference tunnel: the real one starts a static server
    // and cloudflared, which a unit test must not do.
    ctx.provide('mediaUrl', {
      async normalize(file: string) {
        return `https://tunnel.example/${file.split(/[\\/]/).pop() ?? 'ref'}`
      },
    })
  }
  const provider = new StubVideoProvider()
  ctx.media.registerVideoProvider(provider)
  return { ctx, provider }
}

function fakeRequest(options: { method?: string; headers?: Record<string, string>; body?: Buffer }) {
  const body = options.body ?? Buffer.alloc(0)
  return {
    method: options.method ?? 'POST',
    headers: { 'x-roubaai-workspace': scratch, ...options.headers },
    on(event: string, listener: (arg?: unknown) => void) {
      if (event === 'data') listener(body)
      if (event === 'end') setImmediate(() => listener())
      return this
    },
  }
}

function fakeResponse() {
  const chunks: Buffer[] = []
  const res = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  }) as Writable & { status: number; headers: Record<string, string>; writeHead(status: number, headers?: Record<string, string>): unknown }
  res.status = 0
  res.headers = {}
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers ?? {}
    return res
  }
  ;(res as unknown as { body: () => string }).body = () => Buffer.concat(chunks).toString('utf8')
  return res
}

async function call(
  ctx: Context,
  options: { path?: string; method?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = fakeResponse()
  await handleOpenAiRequest(
    ctx,
    fakeRequest(options) as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    new URL(options.path ?? VIDEOS, 'http://127.0.0.1:3080'),
  )
  await new Promise<void>((resolve) => {
    if (res.writableFinished) resolve()
    else res.on('finish', () => resolve())
  })
  const text = (res as unknown as { body: () => string }).body()
  return { status: res.status, json: text === '' ? {} : JSON.parse(text) as Record<string, unknown> }
}

/** Build a multipart body with the same framing a browser posts. */
function multipart(fields: Record<string, string>, files: Array<{ name: string; filename: string; data: Buffer }> = []) {
  const boundary = '----roubaai-test-boundary'
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'))
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: image/png\r\n\r\n`, 'utf8'))
    chunks.push(file.data)
    chunks.push(Buffer.from('\r\n', 'utf8'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

describe('multipart reader', () => {
  it('reads a text field and a file part', () => {
    const { body, contentType } = multipart({ prompt: '一只狐狸' }, [{ name: 'image[]', filename: 'a.png', data: Buffer.from([1, 2, 3]) }])
    expect(boundaryOf(contentType)).toBe('----roubaai-test-boundary')
    const parts = parseMultipart(contentType, body)
    expect(textField(parts, 'prompt')).toBe('一只狐狸')
    const files = fileFields(parts, 'image')
    expect(files).toHaveLength(1)
    expect(files[0]?.filename).toBe('a.png')
    expect([...(files[0]?.data ?? [])]).toEqual([1, 2, 3])
  })

  it('answers nothing for a body that is not multipart', () => {
    expect(parseMultipart('application/json', Buffer.from('{}'))).toEqual([])
  })
})

describe('openai facade: video tasks', () => {
  it('submits a task from the multipart body and maps its fields', async () => {
    const { ctx, provider } = await boot()
    const { body, contentType } = multipart({
      prompt: '一只狐狸起飞',
      model: 'stub-video-2',
      seconds: '8',
      size: '1280x720',
      resolution_name: '1080p',
      generate_audio: 'true',
    })
    const { status, json } = await call(ctx, { headers: { 'content-type': contentType }, body })
    expect(status).toBe(200)
    expect(json['status']).toBe('pending')
    expect(typeof json['id']).toBe('string')
    expect(provider.inputs[0]).toMatchObject({
      prompt: '一只狐狸起飞',
      model: 'stub-video-2',
      duration: 8,
      resolution: '1080p',
      generateAudio: true,
    })
    // Pixels cannot travel as `size` (that field is a ratio), so they ride as dimensions.
    expect(provider.inputs[0]?.extra).toMatchObject({ width: 1280, height: 720 })
  })

  it('reports running, then completes with a locally cached URL and lands the clip', async () => {
    const { ctx, provider } = await boot()
    const cached = join(scratch, 'clip.mp4')
    await writeFile(cached, Buffer.from([0, 1, 2, 3, 4, 5]))
    provider.resultUrl = 'https://cdn.example/clip.mp4'
    registerLocalMedia({ url: provider.resultUrl, filePath: cached, mediaType: 'video/mp4' })

    const created = await call(ctx, { headers: { 'content-type': multipart({ prompt: 'x' }).contentType }, body: multipart({ prompt: 'x' }).body })
    const id = String(created.json['id'])

    const first = await call(ctx, { path: `${VIDEOS}/${id}`, method: 'GET' })
    expect(first.status).toBe(200)
    expect(first.json['status']).toBe('pending')

    const second = await call(ctx, { path: `${VIDEOS}/${id}`, method: 'GET' })
    expect(second.status).toBe(200)
    expect(second.json['status']).toBe('completed')
    expect(String(second.json['url'])).toContain('/api/roubaai-media/media')
    const info = second.json['roubaai'] as Record<string, unknown>
    expect(info['landed']).toBe(true)
    expect(String(info['assetPath'])).toContain(join('.assets', 'default', '05_视频片段'))
  })

  it('states that reference images need the public-reference tunnel when the host has none', async () => {
    const { ctx } = await boot()
    const { body, contentType } = multipart({ prompt: 'x' }, [{ name: 'image[]', filename: 'ref.png', data: Buffer.from([1]) }])
    const { status, json } = await call(ctx, { headers: { 'content-type': contentType }, body })
    expect(status).toBe(501)
    expect((json['error'] as { type: string }).type).toBe('unsupported_error')
  })

  it('publishes reference images as provider-fetchable URLs', async () => {
    const { ctx, provider } = await boot({ normalizer: true })
    const { body, contentType } = multipart(
      { prompt: '让它动起来' },
      [
        { name: 'image[]', filename: 'first.png', data: Buffer.from([1, 2]) },
        { name: 'video[]', filename: 'ref.mp4', data: Buffer.from([3, 4]) },
      ],
    )
    const { status } = await call(ctx, { headers: { 'content-type': contentType }, body })
    expect(status).toBe(200)
    // Staged under a generated name (the upload's own name is not trusted as a
    // path), so assert the shape rather than the original file name.
    expect(provider.inputs[0]?.imageUrls?.[0]).toMatch(/^https:\/\/tunnel\.example\/[0-9a-f-]+\.png$/)
    expect(provider.inputs[0]?.videoUrls?.[0]).toMatch(/^https:\/\/tunnel\.example\/[0-9a-f-]+\.mp4$/)
  })

  it('answers 404 for a task it never issued', async () => {
    const { ctx } = await boot()
    const { status } = await call(ctx, { path: `${VIDEOS}/nope`, method: 'GET' })
    expect(status).toBe(404)
  })

  it('rejects a create without a multipart body', async () => {
    const { ctx } = await boot()
    const { status } = await call(ctx, { headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') })
    expect(status).toBe(400)
  })
})
