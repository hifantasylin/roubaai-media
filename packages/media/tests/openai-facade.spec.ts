import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ImageProvider, MediaRuntimeLocal } from '../src/index.ts'
import type { ImageCaps, ImageGenerateInput, ImageGenerationResult, ProviderProbeResult } from '../src/index.ts'
import { OPENAI_FACADE_PREFIX, handleOpenAiRequest, mapImageRequest } from '../src/openai-facade.ts'

const GENERATIONS = `${OPENAI_FACADE_PREFIX}/v1/images/generations`

/** An image provider that records its input and answers a canned result. */
class StubImageProvider extends ImageProvider {
  readonly provider = 'stub-image'
  readonly defaultModel = 'stub-image-v1'
  inputs: ImageGenerateInput[] = []
  resultUrl: string | undefined = 'https://cdn.example/generated.png'
  localUrl: string | undefined = 'http://127.0.0.1:3080/api/roubaai-media/media?id=1&exp=2&sig=3'
  async generate(input: ImageGenerateInput): Promise<ImageGenerationResult> {
    this.inputs.push(input)
    return {
      kind: 'image',
      mediaType: 'image/png',
      ...this.resultUrl === undefined ? {} : { resultUrl: this.resultUrl },
      ...this.localUrl === undefined
        ? {}
        : { mediaRef: { url: this.resultUrl ?? 'https://cdn.example/fallback.png', mediaType: 'image/png', expiresAt: Date.now() + 86_400_000, localUrl: this.localUrl } },
      providerMeta: { provider: this.provider, model: this.defaultModel },
      run: { model: this.defaultModel, tier: '2K', size: '2048x1152' },
    }
  }
  caps(): ImageCaps {
    return { maxRefImages: 9 }
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

/** A request stand-in that emits its body on the events `readBody` subscribes to. */
function fakeRequest(input: { method?: string; headers?: Record<string, string>; body?: string }) {
  const body = input.body ?? ''
  return {
    method: input.method ?? 'POST',
    headers: input.headers ?? {},
    on(event: string, listener: (arg?: unknown) => void) {
      if (event === 'data') listener(Buffer.from(body, 'utf8'))
      // `end` resolves the read; deferring it keeps the handler's own ordering
      // intact instead of resolving before it finished subscribing.
      if (event === 'end') setImmediate(() => listener())
      return this
    },
  }
}

function fakeResponse() {
  return {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      this.status = status
      this.headers = headers ?? {}
      return this
    },
    end(chunk?: string | Buffer) {
      this.body = chunk === undefined ? '' : String(chunk)
      return this
    },
  }
}

async function boot(): Promise<{ ctx: Context; provider: StubImageProvider }> {
  const ctx = new Context()
  new MediaRuntimeLocal(ctx)
  const provider = new StubImageProvider()
  ctx.media.registerImageProvider(provider)
  return { ctx, provider }
}

async function call(
  ctx: Context,
  options: { path?: string; method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = fakeRequest({
    ...options.method === undefined ? {} : { method: options.method },
    ...options.headers === undefined ? {} : { headers: options.headers },
    body: options.body === undefined ? '' : JSON.stringify(options.body),
  })
  const res = fakeResponse()
  await handleOpenAiRequest(
    ctx,
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    new URL(options.path ?? GENERATIONS, 'http://127.0.0.1:3080'),
  )
  return { status: res.status, json: res.body === '' ? {} : JSON.parse(res.body) as Record<string, unknown> }
}

describe('openai facade: image generations', () => {
  it('serves a text-to-image call through the registered provider and maps size to pixels', async () => {
    const { ctx, provider } = await boot()
    const { status, json } = await call(ctx, { body: { prompt: '一只狐狸', size: '1344x768', quality: 'high' } })

    expect(status).toBe(200)
    expect((json['data'] as Array<{ url: string }>)[0]?.url).toBe('http://127.0.0.1:3080/api/roubaai-media/media?id=1&exp=2&sig=3')
    expect(json['roubaai']).toMatchObject({ provider: 'stub-image', model: 'stub-image-v1', size: '2048x1152', ledger: false, landed: false })
    expect(provider.inputs[0]).toMatchObject({ prompt: '一只狐狸', width: 1344, height: 768, quality: 'high' })
  })

  it('accepts the same endpoint without the /v1 segment', async () => {
    const { ctx } = await boot()
    const { status } = await call(ctx, { path: `${OPENAI_FACADE_PREFIX}/images/generations`, body: { prompt: 'x' } })
    expect(status).toBe(200)
  })

  it('keeps the provider URL when the bytes cannot be cached locally', async () => {
    const { ctx, provider } = await boot()
    // Port 9 refuses instantly, so the cache attempt fails without depending on
    // the network: the run still answers, with the URL it already holds.
    provider.localUrl = undefined
    provider.resultUrl = 'http://127.0.0.1:9/generated.png'
    const { status, json } = await call(ctx, { body: { prompt: 'x' } })
    expect(status).toBe(200)
    expect((json['data'] as Array<{ url: string }>)[0]?.url).toBe('http://127.0.0.1:9/generated.png')
  })

  it('refuses a cross-origin browser request', async () => {
    const { ctx } = await boot()
    const { status } = await call(ctx, {
      headers: { origin: 'http://evil.test', host: '127.0.0.1:3080' },
      body: { prompt: 'x' },
    })
    expect(status).toBe(403)
  })

  it('rejects a non-POST method', async () => {
    const { ctx } = await boot()
    const { status } = await call(ctx, { method: 'GET' })
    expect(status).toBe(405)
  })

  it('states that the multipart edit endpoint is unimplemented rather than answering 404', async () => {
    const { ctx } = await boot()
    const { status, json } = await call(ctx, { path: `${OPENAI_FACADE_PREFIX}/v1/images/edits`, body: { prompt: 'x' } })
    expect(status).toBe(501)
    expect((json['error'] as { type: string }).type).toBe('unsupported_error')
  })

  it('requires a non-empty prompt', async () => {
    const { ctx, provider } = await boot()
    const { status } = await call(ctx, { body: { prompt: '   ' } })
    expect(status).toBe(400)
    expect(provider.inputs).toHaveLength(0)
  })

  it('reports an upstream failure as 502 instead of a 200 with no image', async () => {
    const { ctx, provider } = await boot()
    provider.resultUrl = undefined
    provider.localUrl = undefined
    const { status } = await call(ctx, { body: { prompt: 'x' } })
    expect(status).toBe(502)
  })
})

describe('openai facade: request mapping', () => {
  it('keeps a tier name in resolution and an aspect ratio in aspectRatio', () => {
    const { input, ignored } = mapImageRequest({ prompt: 'x', size: '1.5K', aspect_ratio: '16:9' })
    expect(input).toMatchObject({ prompt: 'x', resolution: '1.5K', aspectRatio: '16:9' })
    expect(ignored).toEqual([])
  })

  it('ignores auto size and names the fields it dropped', () => {
    const { input, ignored } = mapImageRequest({ prompt: 'x', size: 'auto', n: 4, seed: 7 })
    expect(input.width).toBeUndefined()
    expect(input.height).toBeUndefined()
    expect(ignored).toContain('n')
    expect(ignored).toContain('seed')
  })
})
