import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ImageProvider, MediaRuntimeLocal } from '../src/index.ts'
import type { ImageCaps, ImageGenerateInput, ImageGenerationResult, ProviderProbeResult } from '../src/index.ts'
import { OPENAI_FACADE_PREFIX, handleOpenAiRequest, mapImageRequest } from '../src/openai-facade.ts'
import { registerLocalMedia } from '../src/media-cache.ts'

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

async function boot(options: { normalizer?: boolean } = {}): Promise<{ ctx: Context; provider: StubImageProvider }> {
  const ctx = new Context()
  new MediaRuntimeLocal(ctx)
  if (options.normalizer === true) {
    // Stands in for the reference tunnel (a real one starts cloudflared).
    ctx.provide('mediaUrl', {
      async normalize(file: string) {
        return `https://tunnel.example/${file.split(/[\\/]/).pop() ?? 'ref'}`
      },
    })
  }
  const provider = new StubImageProvider()
  ctx.media.registerImageProvider(provider)
  return { ctx, provider }
}

/**
 * A throwaway workspace for every call: the facade lands assets and writes the
 * cost ledger under whatever workspace it is told about, and a test must never
 * write those into the repository it is running from.
 */
let scratch = ''
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'roubaai-facade-'))
})
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function call(
  ctx: Context,
  options: { path?: string; method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = fakeRequest({
    ...options.method === undefined ? {} : { method: options.method },
    // Every call names the throwaway workspace unless a test overrides it.
    headers: { 'x-roubaai-workspace': scratch, ...options.headers },
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
    expect(json['roubaai']).toMatchObject({ provider: 'stub-image', model: 'stub-image-v1', size: '2048x1152' })
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

  it('lists the configured models in the OpenAI shape the canvas reads', async () => {
    const { ctx } = await boot()
    const { status, json } = await call(ctx, { path: `${OPENAI_FACADE_PREFIX}/v1/models`, method: 'GET' })
    expect(status).toBe(200)
    expect(json['object']).toBe('list')
    expect((json['data'] as Array<{ id: string }>).map((model) => model.id)).toContain('stub-image-v1')
  })

  it('rejects a non-POST method and names it', async () => {
    const { ctx } = await boot()
    const { status, json } = await call(ctx, { method: 'GET' })
    expect(status).toBe(405)
    expect(String((json['error'] as { message: string }).message)).toContain('GET')
    expect(String((json['error'] as { message: string }).message)).toContain('expects POST')
  })

  it('answers a CORS preflight instead of rejecting it as a wrong method', async () => {
    const { ctx } = await boot()
    const res = fakeResponse()
    await handleOpenAiRequest(
      ctx,
      fakeRequest({ method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:3000' } }) as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      new URL(GENERATIONS, 'http://127.0.0.1:3080'),
    )
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000')
    expect(String(res.headers['access-control-allow-methods'])).toContain('POST')
  })

  it('accepts another loopback origin but still refuses a public one', async () => {
    const { ctx } = await boot()
    const loopback = await call(ctx, { headers: { origin: 'http://localhost:3000', host: '127.0.0.1:3080' }, body: { prompt: 'x' } })
    expect(loopback.status).toBe(200)
    const publicOrigin = await call(ctx, { headers: { origin: 'https://evil.test', host: '127.0.0.1:3080' }, body: { prompt: 'x' } })
    expect(publicOrigin.status).toBe(403)
  })

  it('answers 400 for an edit body that carries no image to edit', async () => {
    const { ctx } = await boot()
    const { status } = await call(ctx, { path: `${OPENAI_FACADE_PREFIX}/v1/images/edits`, body: { prompt: 'x' } })
    // A JSON body is not multipart, so it has no parts and no image: refused, and
    // never answered with the old "unimplemented" 501 — edits are served now.
    expect(status).toBe(400)
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

describe('openai facade: landing and ledger', () => {
  it('writes the generated bytes into .assets, indexes them and records the cost', async () => {
    const { ctx, provider } = await boot()
    const workspace = await mkdtemp(join(tmpdir(), 'roubaai-canvas-'))
    const cachedFile = join(workspace, 'source.png')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    await writeFile(cachedFile, png)
    // Pretend the provider URL is already cached, so the facade reads the bytes
    // from that cached copy instead of reaching the network.
    const cdn = 'https://cdn.example/landed.png'
    registerLocalMedia({ url: cdn, filePath: cachedFile, mediaType: 'image/png' })
    provider.resultUrl = cdn
    provider.localUrl = undefined

    const { status, json } = await call(ctx, {
      headers: {
        'x-roubaai-workspace': workspace,
        'x-roubaai-project': '画布项目',
        'x-roubaai-dir': '01_试验',
        'x-roubaai-name': '镜01',
      },
      body: { prompt: '教室里的一束光', size: '1024x1024' },
    })

    expect(status).toBe(200)
    const info = json['roubaai'] as Record<string, unknown>
    expect(info['landed']).toBe(true)
    expect(info['ledger']).toBe(true)
    const assetPath = String(info['assetPath'])
    expect(assetPath).toContain(join('.assets', '画布项目', '01_试验', '镜01.png'))
    expect((await readFile(assetPath)).byteLength).toBe(png.byteLength)
    expect(await readFile(join(workspace, '.assets', '画布项目', 'assets-index.md'), 'utf8')).toContain('镜01.png')
    expect(await readFile(join(workspace, '.assets', '画布项目', 'media-cost.jsonl'), 'utf8')).toContain('"tool":"image"')
    await rm(workspace, { recursive: true, force: true })
  })

  it('still answers with the image when there is nothing to land', async () => {
    const { ctx, provider } = await boot()
    // Port 9 refuses instantly: caching fails, so no bytes exist and the run
    // must still answer 200 rather than report a caching problem as a failure.
    provider.resultUrl = 'http://127.0.0.1:9/nowhere.png'
    provider.localUrl = undefined
    const { status, json } = await call(ctx, { body: { prompt: 'x' } })
    expect(status).toBe(200)
    expect((json['roubaai'] as Record<string, unknown>)['landed']).toBe(false)
  })
})

describe('openai facade: reference edits', () => {
  /** Build the multipart body the canvas posts to `/v1/images/edits`. */
  function editBody(fields: Record<string, string>, files: Array<{ name: string; filename: string; data: Buffer }>) {
    const boundary = '----roubaai-edit'
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

  it('publishes the edited reference and answers with the finished image', async () => {
    const { ctx, provider } = await boot({ normalizer: true })
    const { body, contentType } = editBody({ prompt: '换成夜晚' }, [{ name: 'image[]', filename: 'scene.png', data: Buffer.from([9, 8, 7]) }])
    // The call helper stringifies a JSON body; this one needs bytes, so drive the
    // request directly with a binary payload.
    const request = {
      method: 'POST',
      headers: { 'content-type': contentType, 'x-roubaai-workspace': scratch },
      on(event: string, listener: (arg?: unknown) => void) {
        if (event === 'data') listener(body)
        if (event === 'end') setImmediate(() => listener())
        return this
      },
    }
    const res = { status: 0, body: '', writeHead(status: number) { this.status = status; return this }, end(chunk?: string) { this.body = chunk ?? ''; return this } }
    await handleOpenAiRequest(
      ctx,
      request as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      new URL(`${OPENAI_FACADE_PREFIX}/v1/images/edits`, 'http://127.0.0.1:3080'),
    )
    expect(res.status).toBe(200)
    expect(provider.inputs[0]?.prompt).toBe('换成夜晚')
    expect(provider.inputs[0]?.refImages?.[0]).toMatch(/^https:\/\/tunnel\.example\/[0-9a-f-]+\.png$/)
  })

  it('refuses an edit without an image part', async () => {
    const { ctx } = await boot({ normalizer: true })
    const { body, contentType } = editBody({ prompt: 'x' }, [])
    const request = {
      method: 'POST',
      headers: { 'content-type': contentType, 'x-roubaai-workspace': scratch },
      on(event: string, listener: (arg?: unknown) => void) {
        if (event === 'data') listener(body)
        if (event === 'end') setImmediate(() => listener())
        return this
      },
    }
    const res = { status: 0, writeHead(status: number) { this.status = status; return this }, end() { return this } }
    await handleOpenAiRequest(
      ctx,
      request as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      new URL(`${OPENAI_FACADE_PREFIX}/v1/images/edits`, 'http://127.0.0.1:3080'),
    )
    expect(res.status).toBe(400)
  })
})

describe('openai facade: request mapping', () => {  it('keeps a tier name in resolution and an aspect ratio in aspectRatio', () => {
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
