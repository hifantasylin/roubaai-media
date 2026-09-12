/**
 * Ark image (Seedream) adapter behavior: the request it builds, the pixel size
 * it resolves, the result it lands or degrades, and the model catalogue it reads
 * out of Ark. Ark speaks its own protocol, so these specs pin the mapping rather
 * than a shared shape.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  ArkImageProvider,
  DEFAULT_IMAGE_MODEL,
  MissingCredentialError,
} from '../src/index.ts'

const BASE = 'https://ark.example/api/v3'

/** One recorded request. */
interface RecordedCall {
  url: string
  method: string
  body: unknown
  authorization: string | undefined
}

/** A fake `fetch` response with the subset of the Response API these paths use. */
function fakeResponse(status: number, data: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return JSON.stringify(data)
    },
  } as unknown as Response
}

/** A fake response for the image download: a one-chunk body and a stated size. */
function fakeBytesResponse(status: number, bytes: Uint8Array): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    headers: new Headers({ 'content-length': String(bytes.byteLength) }),
  } as unknown as Response
}

/** Stub `fetch` with a URL-keyed router, recording every request. */
function stubRoutes(
  routes: Array<{ match: string; respond: (url: string) => Response }>,
  calls: RecordedCall[] = [],
): RecordedCall[] {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: (init.headers as Record<string, string> | undefined)?.['authorization'],
    })
    const route = routes.find((candidate) => url.includes(candidate.match))
    if (route === undefined) throw new Error(`unexpected request to ${url}`)
    return route.respond(url)
  })
  return calls
}

/** Stub attachments service: records saveImage calls, returns a canned ref. */
class StubAttachments {
  readonly saves: Array<{ data: Uint8Array; mediaType: string; name?: string }> = []
  async saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown> {
    this.saves.push(input)
    return {
      attachmentId: `sha256:${'a'.repeat(64)}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...(input.name === undefined ? {} : { name: input.name }),
    }
  }
}

/** A context whose credentials service resolves the given key. */
function contextWithKey(key = 'ark-key'): Context {
  const ctx = new Context()
  ctx.provide('credentials', { resolve: async () => ({ value: key, source: 'memory' }) })
  return ctx
}

/** A context carrying the key and an attachments service that lands images. */
function boot(key = 'ark-key'): { ctx: Context; attachments: StubAttachments } {
  const ctx = contextWithKey(key)
  const attachments = new StubAttachments()
  ctx.provide('attachments', attachments)
  return { ctx, attachments }
}

function provider(ctx: Context, config: { model?: string } = {}): ArkImageProvider {
  return new ArkImageProvider(ctx, { baseUrl: BASE, ...config })
}

/** The request body of the one generation call a test made. */
function submittedBody(calls: RecordedCall[]): Record<string, unknown> {
  return (calls.find((call) => call.url.includes('/images/generations'))?.body ?? {}) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ArkImageProvider defaults', () => {
  it('names the ark adapter and Ark\u2019s plain (lite class) Seedream 5.0 default', () => {
    const instance = provider(contextWithKey())
    expect(instance.provider).toBe('ark')
    expect(instance.defaultModel).toBe(DEFAULT_IMAGE_MODEL)
    expect(instance.defaultModel).toBe('doubao-seedream-5-0-260128')
  })

  it('states no USD figure: Ark bills in RMB', () => {
    expect(provider(contextWithKey()).estimateCostUsd('doubao-seedream-5-0-pro-260628', '2K')).toBeUndefined()
  })
})

describe('ArkImageProvider per-model capability', () => {
  it('describes each generation from the one table the request builder reads', () => {
    const instance = provider(contextWithKey())

    expect(instance.capabilities('doubao-seedream-5-0-pro-260628')).toMatchObject({
      id: 'doubao-seedream-5-0-pro-260628',
      label: 'pro',
      tiers: ['1K', '1.5K', '2K'],
      maxRefImages: 10,
    })
    // The plain 5.0 id carries no pro/lite segment and IS the lite class: its
    // tiers and its pixel floor are the strictest of the set, so an id that
    // matched neither pattern used to be answered with the WIDEST bounds —
    // exactly backwards. This is the regression the plain entry exists for.
    expect(instance.capabilities('doubao-seedream-5-0-260128')).toMatchObject({
      id: 'doubao-seedream-5-0-260128',
      label: 'lite',
      tiers: ['2K', '3K', '4K'],
      minPixels: 3_686_400,
      maxRefImages: 14,
    })
    expect(instance.capabilities('doubao-seedream-5-0-lite-260628')).toMatchObject({
      label: 'lite',
      tiers: ['2K', '3K', '4K'],
      minPixels: 3_686_400,
    })
    expect(instance.capabilities('doubao-seedream-4-5-251128')).toMatchObject({ label: '4.5', tiers: ['2K', '4K'] })
    expect(instance.capabilities('doubao-seedream-4-0-250828')).toMatchObject({ label: '4.0', tiers: ['1K', '2K', '4K'] })
  })

  it('states the aspect ratios its pixel table can resolve, and a human hint', () => {
    const capability = provider(contextWithKey()).capabilities('doubao-seedream-5-0-260128')
    expect(capability?.aspectRatios).toContain('3:2')
    // The verified cell: 3:2 at 1.5K is 1872x1248 on Ark.
    expect(capability?.aspectRatios).toContain('21:9')
    expect(typeof capability?.note).toBe('string')
    expect(capability?.note?.length).toBeGreaterThan(0)
  })

  it('describes the model it is currently configured to run when asked for none', () => {
    const instance = provider(contextWithKey(), { model: 'doubao-seedream-4-5-251128' })
    expect(instance.capabilities()).toMatchObject({ id: 'doubao-seedream-4-5-251128', label: '4.5' })
  })

  it('states nothing for an id it cannot place, so a caller passes the request through', () => {
    expect(provider(contextWithKey()).capabilities('doubao-seedream-9-9-270101')).toBeUndefined()
  })

  it('never reads a release date as a version segment', () => {
    // `doubao-seedream-4-0-250828` contains the digits `50` inside its date, and
    // `…-240040` contains `40`: an unanchored version pattern answers both with
    // the wrong class, which is how a model gets the wrong tiers and floor.
    const instance = provider(contextWithKey())
    expect(instance.capabilities('doubao-seedream-6-0-250050')).toBeUndefined()
    expect(instance.capabilities('doubao-seedream-4-5-250050')).toMatchObject({ label: '4.5' })
  })
})

describe('ArkImageProvider pixel floor', () => {
  it('refuses an explicit size under the model floor before spending the call', async () => {
    const calls = stubRoutes([{ match: '/images/generations', respond: () => fakeResponse(200, { data: [] }) }])
    const { ctx } = boot()

    const error = await provider(ctx).generate({ prompt: 'x', width: 1536, height: 1536 })
      .catch((caught: unknown) => caught)

    expect((error as Error).message).toContain('3,686,400')
    expect((error as { status?: number }).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('accepts a size exactly at the floor and does not judge a bare tier string', async () => {
    const calls = stubRoutes([
      { match: '/images/generations', respond: () => fakeResponse(200, { data: [{ url: 'https://cdn/i.png' }] }) },
      { match: 'https://cdn/i.png', respond: () => fakeBytesResponse(200, new Uint8Array([1])) },
    ])
    const { ctx } = boot()

    // 1920x1920 is exactly 3,686,400 pixels.
    await provider(ctx).generate({ prompt: 'x', width: 1920, height: 1920 })
    expect(submittedBody(calls)['size']).toBe('1920x1920')

    // A tier the table has no cell for reaches Ark as a string: no pixel count
    // exists here, so the floor is Ark's call, not a guess of ours.
    calls.length = 0
    await provider(ctx).generate({ prompt: 'x', resolution: '3K', aspectRatio: '4:3' })
    expect(submittedBody(calls)['size']).toBe('3K')
  })

  it('lets an explicit model override pick a generation without the floor', async () => {
    const calls = stubRoutes([
      { match: '/images/generations', respond: () => fakeResponse(200, { data: [{ url: 'https://cdn/i.png' }] }) },
      { match: 'https://cdn/i.png', respond: () => fakeBytesResponse(200, new Uint8Array([1])) },
    ])
    const { ctx } = boot()

    await provider(ctx).generate({
      prompt: 'x',
      model: 'doubao-seedream-5-0-pro-260628',
      width: 1024,
      height: 768,
    })

    expect(submittedBody(calls)['model']).toBe('doubao-seedream-5-0-pro-260628')
    expect(submittedBody(calls)['size']).toBe('1024x768')
  })
})

describe('ArkImageProvider caps', () => {
  it('reads the reference bound out of the model generation', () => {
    const instance = provider(contextWithKey())
    expect(instance.caps('doubao-seedream-5-0-pro-260628')).toEqual({ maxRefImages: 10 })
    expect(instance.caps('doubao-seedream-5-0-lite-260628')).toEqual({ maxRefImages: 14 })
    expect(instance.caps('doubao-seedream-4-5-251128')).toEqual({ maxRefImages: 14 })
    expect(instance.caps('doubao-seedream-4-0-250828')).toEqual({ maxRefImages: 14 })
  })

  it('takes the wider bound for an id it cannot place', () => {
    expect(provider(contextWithKey()).caps('doubao-seedream-9-9-270101')).toEqual({ maxRefImages: 14 })
  })
})

describe('ArkImageProvider submit body', () => {
  it('posts the Seedream body with the bearer key and no watermark', async () => {
    const calls = stubRoutes([
      { match: '/images/generations', respond: () => fakeResponse(200, { data: [{ url: 'https://cdn/i.png' }] }) },
      { match: 'https://cdn/i.png', respond: () => fakeBytesResponse(200, new Uint8Array([0x89, 0x50, 0x4e, 0x47])) },
    ])
    const { ctx } = boot()

    await provider(ctx).generate({ prompt: 'a red panda', width: 2048, height: 2048 })

    expect(calls[0]!.url).toBe(`${BASE}/images/generations`)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.authorization).toBe('Bearer ark-key')
    expect(calls[0]!.body).toMatchObject({
      model: 'doubao-seedream-5-0-260128',
      prompt: 'a red panda',
      response_format: 'url',
      watermark: false,
      sequential_image_generation: 'disabled',
      size: '2048x2048',
    })
  })

  it('omits sequential_image_generation where the generation refuses it', async () => {
    // The pro generation draws exactly one image and Ark rejects the parameter
    // outright, failing the whole request with 400 before anything is drawn.
    const calls = stubRoutes([
      { match: '/images/generations', respond: () => fakeResponse(200, { data: [{ url: 'https://cdn/i.png' }] }) },
      { match: 'https://cdn/i.png', respond: () => fakeBytesResponse(200, new Uint8Array([1, 2, 3])) },
    ])
    const { ctx } = boot()

    await provider(ctx).generate({
      prompt: 'x',
      model: 'doubao-seedream-5-0-pro-260628',
      resolution: '1.5K',
      aspectRatio: '1:1',
    })

    const body = submittedBody(calls)
    expect(body['model']).toBe('doubao-seedream-5-0-pro-260628')
    expect(body['sequential_image_generation']).toBeUndefined()
  })

  it('sends one reference image as a string and several as an array', async () => {
    const calls = stubRoutes([
      { match: '/images/generations', respond: () => fakeResponse(200, { data: [{ url: 'https://cdn/i.png' }] }) },
      { match: 'https://cdn/i.png', respond: () => fakeBytesResponse(200, new Uint8Array([1, 2, 3])) },
    ])
    const { ctx } = boot()

    await provider(ctx).generate({ prompt: 'edit', refImages: ['https://cdn/one.png'] })
    expect(submittedBody(calls)['image']).toBe('https://cdn/one.png')

    calls.length = 0
    await provider(ctx).generate({
      prompt: 'edit',
      refImages: ['https://cdn/a.png', 'data:image/png;base64,AAAA'],
    })
    expect(submittedBody(calls)['image']).toEqual(['https://cdn/a.png', 'data:image/png;base64,AAAA'])
  })

  it('lets extra override the documented body fields only', async () => {
    const calls = stubRoutes([
      { match: '/images/generations', respond: () => fakeResponse(200, { data: [{ url: 'https://cdn/i.png' }] }) },
      { match: 'https://cdn/i.png', respond: () => fakeBytesResponse(200, new Uint8Array([1, 2, 3])) },
    ])
    const { ctx } = boot()

    await provider(ctx).generate({
      prompt: 'x',
      extra: { watermark: true, output_format: 'jpeg', background: 'opaque', model: 'hijacked' },
    })

    const body = submittedBody(calls)
    expect(body['watermark']).toBe(true)
    expect(body['output_format']).toBe('jpeg')
    expect(body['background']).toBe('opaque')
    // Not a documented Ark image parameter: never forwarded from `extra`.
    expect(body['model']).toBe('doubao-seedream-5-0-260128')
  })
})

describe('ArkImageProvider size mapping', () => {
  /** Post one generation and return the `size` field it carried. */
  async function sizeFor(
    input: Parameters<ArkImageProvider['generate']>[0],
    config: { model?: string } = {},
  ): Promise<unknown> {
    const calls = stubRoutes([
      { match: '/images/generations', respond: () => fakeResponse(200, { data: [{ url: 'https://cdn/i.png' }] }) },
      { match: 'https://cdn/i.png', respond: () => fakeBytesResponse(200, new Uint8Array([1])) },
    ])
    const { ctx } = boot()
    await provider(ctx, config).generate(input)
    return submittedBody(calls)['size']
  }

  it('uses an explicit width\u00d7height pair as given', async () => {
    expect(await sizeFor({ prompt: 'x', width: 2048, height: 2048 })).toBe('2048x2048')
  })

  it('looks the pixel size up for a resolution and ratio the generation supports', async () => {
    // The default (lite class) accepts 2K/3K/4K.
    expect(await sizeFor({ prompt: 'x', resolution: '2K', aspectRatio: '16:9' })).toBe('2816x1584')
    expect(await sizeFor({ prompt: 'x', resolution: '3K', aspectRatio: '16:9' })).toBe('4096x2304')
    // 5.0 pro carries the 1K/1.5K middle tiers the lite class does not.
    expect(await sizeFor({ prompt: 'x', resolution: '1K', aspectRatio: '1:1' }, { model: 'doubao-seedream-5-0-pro-260628' }))
      .toBe('1024x1024')
    expect(await sizeFor({ prompt: 'x', resolution: '1.5K', aspectRatio: '21:9' }, { model: 'doubao-seedream-5-0-pro-260628' }))
      .toBe('2352x1008')
    // The verified cell: 3:2 at 1.5K resolves to Ark's own 1872x1248.
    expect(await sizeFor({ prompt: 'x', resolution: '1.5K', aspectRatio: '3:2' }, { model: 'doubao-seedream-5-0-pro-260628' }))
      .toBe('1872x1248')
    // 4.5 accepts 2K/4K.
    expect(await sizeFor({ prompt: 'x', resolution: '4K', aspectRatio: '1:1' }, { model: 'doubao-seedream-4-5-251128' }))
      .toBe('4096x4096')
  })

  it('falls back to the resolution tier when the generation or the table has no entry', async () => {
    // 5.0 lite spans 2K/3K/4K, so a 1K request has no pixel mapping.
    expect(await sizeFor({ prompt: 'x', resolution: '1K', aspectRatio: '1:1' }, { model: 'doubao-seedream-5-0-lite-260628' }))
      .toBe('1K')
    // Ark documents no 3K size for 4:3.
    expect(await sizeFor({ prompt: 'x', resolution: '3K', aspectRatio: '4:3' }, { model: 'doubao-seedream-5-0-lite-260628' }))
      .toBe('3K')
    // An id whose generation cannot be placed never gets a guessed pixel size.
    expect(await sizeFor({ prompt: 'x', resolution: '2K', aspectRatio: '1:1' }, { model: 'doubao-seedream-9-9-270101' }))
      .toBe('2K')
  })

  it('sends the tier string alone when no ratio is named, defaulting to 2K', async () => {
    expect(await sizeFor({ prompt: 'x' })).toBe('2K')
    expect(await sizeFor({ prompt: 'x', resolution: '4K' })).toBe('4K')
  })
})

describe('ArkImageProvider landing', () => {
  it('downloads the result and lands it through attachments', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    stubRoutes([
      { match: '/images/generations', respond: () => fakeResponse(200, { data: [{ url: 'https://cdn/i.png' }] }) },
      { match: 'https://cdn/i.png', respond: () => fakeBytesResponse(200, png) },
    ])
    const { ctx, attachments } = boot()

    const result = await provider(ctx).generate({ prompt: 'a cat' })

    expect(result.kind).toBe('image')
    expect(result.attachmentRef).toBe(`sha256:${'a'.repeat(64)}`)
    expect(result.mediaType).toBe('image/png')
    expect(result.resultUrl).toBe('https://cdn/i.png')
    expect(result.providerMeta).toMatchObject({ provider: 'ark', model: 'doubao-seedream-5-0-260128' })
    expect(attachments.saves).toHaveLength(1)
    expect([...attachments.saves[0]!.data]).toEqual([...png])
    expect(attachments.saves[0]!.name).toBe('generated.png')
  })

  it('echoes what ran — model, tier, and the pixel size Ark reported', async () => {
    stubRoutes([
      {
        match: '/images/generations',
        respond: () => fakeResponse(200, { data: [{ url: 'https://cdn/i.png', size: '2816x1584' }] }),
      },
      { match: 'https://cdn/i.png', respond: () => fakeBytesResponse(200, new Uint8Array([1])) },
    ])
    const { ctx } = boot()

    const result = await provider(ctx).generate({ prompt: 'a cat', resolution: '2K', aspectRatio: '16:9' })

    expect(result.run).toEqual({
      model: 'doubao-seedream-5-0-260128',
      tier: '2K',
      size: '2816x1584',
    })
  })

  it('omits the tier from the echo when the size came from an explicit pair, not a tier', async () => {
    stubRoutes([
      { match: '/images/generations', respond: () => fakeResponse(200, { data: [{ url: 'https://cdn/i.png' }] }) },
      { match: 'https://cdn/i.png', respond: () => fakeBytesResponse(200, new Uint8Array([1])) },
    ])
    const { ctx } = boot()

    const result = await provider(ctx).generate({ prompt: 'a cat', width: 2048, height: 2048 })

    expect(result.run).toMatchObject({ model: 'doubao-seedream-5-0-260128' })
    expect(result.run?.tier).toBeUndefined()
    // Ark reported no size for this item, so none is echoed.
    expect(result.run?.size).toBeUndefined()
  })

  it('lands an inline b64_json result without leaking base64', async () => {
    stubRoutes([
      {
        match: '/images/generations',
        respond: () => fakeResponse(200, { data: [{ b64_json: Buffer.from('jpeg-bytes').toString('base64'), output_format: 'jpeg' }] }),
      },
    ])
    const { ctx, attachments } = boot()

    const result = await provider(ctx).generate({ prompt: 'a cat' })

    expect(result.attachmentRef).toBe(`sha256:${'a'.repeat(64)}`)
    expect([...attachments.saves[0]!.data]).toEqual([...new TextEncoder().encode('jpeg-bytes')])
  })

  it('degrades to a URL reference when the result cannot be downloaded', async () => {
    stubRoutes([
      { match: '/images/generations', respond: () => fakeResponse(200, { data: [{ url: 'https://cdn/gone.png', output_format: 'jpeg' }] }) },
      { match: 'https://cdn/gone.png', respond: () => fakeResponse(404, {}) },
    ])
    const { ctx, attachments } = boot()

    const result = await provider(ctx).generate({ prompt: 'a cat' })

    // The image exists at the provider: report the URL, never regenerate.
    expect(result.attachmentRef).toBeUndefined()
    expect(result.mediaRef).toMatchObject({ url: 'https://cdn/gone.png', mediaType: 'image/jpeg' })
    expect(result.mediaRef?.expiresAt).toBeGreaterThan(Date.now())
    expect(attachments.saves).toHaveLength(0)
  })

  it('fails loudly when no key is configured', async () => {
    stubRoutes([{ match: '/images/generations', respond: () => fakeResponse(200, { data: [] }) }])
    await expect(provider(new Context()).generate({ prompt: 'x' }))
      .rejects.toBeInstanceOf(MissingCredentialError)
  })
})

describe('ArkImageProvider model catalogue', () => {
  const catalogue = {
    object: 'list',
    data: [
      { id: 'doubao-seedream-5-0-pro-260628', task_type: ['ImageGeneration'], status: 'available' },
      { id: 'doubao-seedream-4-0-250828', task_type: 'ImageGeneration' },
      { id: 'doubao-seedance-2-0-260128', task_type: ['VideoGeneration'], status: 'available' },
    ],
  }

  it('lists only the seedream image models Ark reports', async () => {
    const calls = stubRoutes([{ match: '/models', respond: () => fakeResponse(200, catalogue) }])
    const models = await provider(contextWithKey()).listModels()

    expect(calls[0]!.url).toBe(`${BASE}/models`)
    expect(calls[0]!.authorization).toBe('Bearer ark-key')
    expect(models).toEqual([
      { id: 'doubao-seedream-5-0-pro-260628', status: 'available', taskTypes: ['ImageGeneration'] },
      { id: 'doubao-seedream-4-0-250828', taskTypes: ['ImageGeneration'] },
    ])
  })

  it('reads the catalogue with the endpoint and key a form holds', async () => {
    const calls = stubRoutes([{ match: '/models', respond: () => fakeResponse(200, catalogue) }])
    await provider(contextWithKey()).listModelsWithDraft({
      baseUrl: 'https://ark-draft.example/api/v3/',
      apiKey: 'draft-key',
    })

    expect(calls[0]!.url).toBe('https://ark-draft.example/api/v3/models')
    expect(calls[0]!.authorization).toBe('Bearer draft-key')
  })

  it('falls back to the configured endpoint and key for an empty draft field', async () => {
    const calls = stubRoutes([{ match: '/models', respond: () => fakeResponse(200, catalogue) }])
    await provider(contextWithKey('stored-key')).listModelsWithDraft({ baseUrl: '', apiKey: '' })

    expect(calls[0]!.url).toBe(`${BASE}/models`)
    expect(calls[0]!.authorization).toBe('Bearer stored-key')
  })
})

describe('ArkImageProvider model-not-found recovery', () => {
  it('names the available models when Ark refuses a retired id', async () => {
    stubRoutes([
      {
        match: '/images/generations',
        respond: () => fakeResponse(404, {
          error: { code: 'InvalidEndpointOrModel.NotFound', message: 'The model or endpoint does not exist' },
        }),
      },
      {
        match: '/models',
        respond: () => fakeResponse(200, {
          data: [
            { id: 'doubao-seedream-5-0-pro-260628', task_type: ['ImageGeneration'] },
            { id: 'doubao-seedream-4-0-250828', task_type: ['ImageGeneration'] },
          ],
        }),
      },
    ])

    const error = await provider(contextWithKey()).generate({ prompt: 'x' }).catch((caught: unknown) => caught)
    const message = (error as Error).message
    expect(message).toContain('InvalidEndpointOrModel.NotFound')
    expect(message).toContain('The model or endpoint does not exist')
    expect(message).toContain('可用模型：doubao-seedream-5-0-pro-260628、doubao-seedream-4-0-250828')
    expect((error as { status?: number }).status).toBe(404)
  })

  it('keeps Ark\u2019s own message when the catalogue cannot be read either', async () => {
    stubRoutes([
      { match: '/images/generations', respond: () => fakeResponse(404, { error: { message: 'model retired' } }) },
      { match: '/models', respond: () => fakeResponse(403, { error: { message: 'denied' } }) },
    ])

    const error = await provider(contextWithKey()).generate({ prompt: 'x' }).catch((caught: unknown) => caught)
    expect((error as Error).message).toContain('model retired')
    expect((error as Error).message).toContain('可用模型列表获取失败')
  })
})

describe('ArkImageProvider probe', () => {
  it('accepts HTTP 200 from the model list as proof of a working key', async () => {
    stubRoutes([{ match: '/models', respond: () => fakeResponse(200, { data: [] }) }])
    await expect(provider(contextWithKey()).probe({ baseUrl: BASE, apiKey: 'sk-test-draft' }))
      .resolves.toEqual({ status: 'ok', message: '连接成功（HTTP 200）' })
  })

  it('carries Ark\u2019s status and error message through a refusal', async () => {
    stubRoutes([{
      match: '/models',
      respond: () => fakeResponse(401, { error: { code: 'AuthenticationError', message: 'The API key is invalid' } }),
    }])
    const result = await provider(contextWithKey()).probe({ baseUrl: BASE, apiKey: 'sk-test-bad' })
    expect(result.status).toBe('failed')
    expect(result.message).toContain('401')
    expect(result.message).toContain('AuthenticationError')
    expect(result.message).toContain('The API key is invalid')
  })

  it('reports a row with no key anywhere as unconfigured, without probing', async () => {
    const calls = stubRoutes([{ match: '/models', respond: () => fakeResponse(200, {}) }])
    // No credential seeded and an empty draft: nothing exists to probe with.
    const result = await provider(new Context()).probe({ baseUrl: BASE, apiKey: '  ' })
    expect(result.status).toBe('unconfigured')
    expect(result.message).toContain('ARK_API_KEY')
    expect(calls).toHaveLength(0)
  })

  it('uses a saved key for the probe when the form is empty', async () => {
    const calls = stubRoutes([{ match: '/models', respond: () => fakeResponse(200, { data: [] }) }])
    const result = await provider(contextWithKey('sk-test-saved')).probe({ baseUrl: BASE, apiKey: '' })
    expect(result.status).toBe('ok')
    expect(calls[0]!.authorization).toBe('Bearer sk-test-saved')
  })

  it('tests the connection through the model list', async () => {
    stubRoutes([{ match: '/models', respond: () => fakeResponse(200, { data: [] }) }])
    await expect(provider(contextWithKey()).testConnection()).resolves.toBe(true)

    stubRoutes([{ match: '/models', respond: () => fakeResponse(403, {}) }])
    await expect(provider(contextWithKey()).testConnection()).resolves.toBe(false)
  })
})
