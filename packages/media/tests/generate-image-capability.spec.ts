/**
 * `generate_image`'s capability-driven call-time behavior: which tier a call
 * ends up asking for, which model serves it, and what the caller is told when
 * nothing can.
 *
 * These specs pin the seam's central rule — per-model capability is the single
 * source of truth. The tool schema carries no tier list, so every decision here
 * is read from the serving provider's own `capabilities()`: a tier the
 * configured model declares runs as asked, a tier only a sibling declares moves
 * the request there and says so, and a tier nothing declares fails with a
 * message that names the model, its tiers, its pixel floor and the siblings'
 * tiers. A provider that states no capability at all must keep behaving exactly
 * as it did before capability existed (no override, no defaulted tier).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ImageProvider, MEDIA_SETTINGS_NAMESPACE, MediaRuntimeLocal } from '../src/index.ts'
import type {
  ImageCaps, ImageGenerateInput, ImageGenerationResult, MediaModelCapability, MediaModelInfo,
  ProviderProbeResult,
} from '../src/index.ts'
import { registerGenerateImage } from '../src/tools/generate-image.ts'

const testToolSignal = new AbortController().signal

/** The lite-class fixture: the tiers this deployment's default model declares. */
const LITE: MediaModelCapability = {
  id: 'stub-lite-260128',
  label: 'lite',
  tiers: ['2K', '3K', '4K'],
  minPixels: 3_686_400,
  maxRefImages: 14,
}

/** The pro-class fixture: the sibling that carries the middle tier. */
const PRO: MediaModelCapability = {
  id: 'stub-pro-260628',
  label: 'pro',
  tiers: ['1K', '1.5K', '2K'],
  maxRefImages: 10,
}

/**
 * An image provider that declares per-model capability, as a real backend with
 * a capability table does. Its `generate` echoes what it actually ran, the same
 * contract the Ark adapter fulfills.
 */
class CapableImageProvider extends ImageProvider {
  readonly provider = 'stub-capable'
  readonly defaultModel = LITE.id
  inputs: ImageGenerateInput[] = []
  constructor(
    private readonly table: Readonly<Record<string, MediaModelCapability>>,
    private readonly catalogue: readonly string[] = Object.keys(table),
    private readonly configured: string = LITE.id,
  ) {
    super()
  }
  capabilities(model?: string): MediaModelCapability | undefined {
    return this.table[model ?? this.configured]
  }
  async listModels(): Promise<MediaModelInfo[]> {
    return this.catalogue.map((id) => ({ id }))
  }
  async generate(input: ImageGenerateInput): Promise<ImageGenerationResult> {
    this.inputs.push(input)
    const model = input.model ?? this.configured
    return {
      kind: 'image',
      attachmentRef: 'att:generated',
      mediaType: 'image/png',
      run: {
        model,
        ...input.resolution === undefined ? {} : { tier: input.resolution },
        size: '2496x1664',
      },
      providerMeta: { provider: this.provider, model },
    }
  }
  caps(): ImageCaps {
    return { maxRefImages: 14 }
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

/** An image provider that states no capability at all — the Maizi shape. */
class OpaqueImageProvider extends ImageProvider {
  readonly provider = 'stub-opaque'
  readonly defaultModel = 'opaque-v1'
  inputs: ImageGenerateInput[] = []
  async generate(input: ImageGenerateInput): Promise<ImageGenerationResult> {
    this.inputs.push(input)
    return {
      kind: 'image',
      attachmentRef: 'att:generated',
      mediaType: 'image/png',
      providerMeta: { provider: this.provider, model: this.defaultModel },
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

/** Minimal jobs registry: records the started spec and exposes the run hooks. */
class StubJobs {
  started: Array<{ kind: string; label: string }> = []
  hooks: Array<{ cancel: (reason?: string) => void; done: Promise<unknown> }> = []
  start(spec: { kind: string; label: string; run: () => { cancel: (reason?: string) => void; done: Promise<unknown> } }): string {
    this.started.push({ kind: spec.kind, label: spec.label })
    this.hooks.push(spec.run())
    return 'job-1'
  }
  onJobDone(): () => void {
    return () => {}
  }
  reportProgress(): void {}
}

/** Boot a context with one registered image provider and optional stored settings. */
async function boot(
  provider: ImageProvider,
  settings?: { ns: string; value: unknown },
): Promise<{ ctx: Context; jobs: StubJobs }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const runtime = new MediaRuntimeLocal(ctx)
  runtime.registerImageProvider(provider)
  const jobs = new StubJobs()
  ctx.provide('jobs', jobs)
  if (settings !== undefined) {
    ctx.provide('settings', { describe: () => [{ ns: settings.ns, value: settings.value }] })
  }
  registerGenerateImage(ctx)
  return { ctx, jobs }
}

/** One stored image row, as the settings page writes it. */
function storedImageRow(row: { id: string; adapter: string; model: string; resolution: string }): unknown {
  return {
    image: {
      activeId: row.id,
      providers: [{
        id: row.id,
        name: '',
        custom: false,
        adapter: row.adapter,
        baseUrl: '',
        model: row.model,
        resolution: row.resolution,
      }],
    },
    keys: {},
  }
}

/** Execute one `generate_image` call and return the tool result. */
async function callImage(
  ctx: Context,
  args: Record<string, unknown>,
  workspace?: string,
): Promise<{ isError: boolean; error?: { message?: string } }> {
  return await ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId('img-cap'),
    name: 'generate_image',
    arguments: args,
    ...workspace === undefined ? {} : { agent: { session: { header: { cwd: workspace } } } as never },
  }) as { isError: boolean; error?: { message?: string } }
}

describe('generate_image capability-driven tier resolution', () => {
  it('asks for the seam default tier when the caller names none', async () => {
    const provider = new CapableImageProvider({ [LITE.id]: LITE, [PRO.id]: PRO })
    const { ctx, jobs } = await boot(provider)

    const result = await callImage(ctx, { prompt: 'a red panda' })
    expect(result.isError).toBe(false)
    await jobs.hooks[0]!.done
    expect(provider.inputs[0]!.resolution).toBe('2K')
    expect(provider.inputs[0]!.model).toBeUndefined()
  })

  it('runs on the configured model when that model declares the tier', async () => {
    const provider = new CapableImageProvider({ [LITE.id]: LITE, [PRO.id]: PRO })
    const { ctx, jobs } = await boot(provider)

    await callImage(ctx, { prompt: 'a red panda', resolution: '3K' })
    await jobs.hooks[0]!.done
    expect(provider.inputs[0]).toMatchObject({ resolution: '3K' })
    expect(provider.inputs[0]!.model).toBeUndefined()
  })

  it('refuses a tier the serving model does not declare instead of running another one', async () => {
    const provider = new CapableImageProvider({ [LITE.id]: LITE, [PRO.id]: PRO })
    const { ctx, jobs } = await boot(provider)

    // The lite class cannot do 1.5K and the pro sibling can, but the deployment
    // chose lite: the call is refused, not quietly moved onto the other model.
    const result = await callImage(ctx, { prompt: 'a red panda', resolution: '1.5K' })

    expect(result.isError).toBe(true)
    const message = result.error?.message ?? ''
    expect(message).toContain(`lite（${LITE.id}）`)
    expect(message).toContain('2K/3K/4K')
    expect(message).toContain(`pro（${PRO.id}）：1K/1.5K/2K`)
    expect(jobs.started).toHaveLength(0)
    expect(provider.inputs).toHaveLength(0)
  })

  it('fails a tier no listed model declares, naming the model, its tiers, its floor and the alternatives', async () => {
    const provider = new CapableImageProvider({ [LITE.id]: LITE, [PRO.id]: PRO })
    const { ctx, jobs } = await boot(provider)

    const result = await callImage(ctx, { prompt: 'a red panda', resolution: '8K' })

    expect(result.isError).toBe(true)
    const message = result.error?.message ?? ''
    expect(message).toContain(`lite（${LITE.id}）`)
    expect(message).toContain('2K/3K/4K')
    expect(message).toContain('3,686,400')
    expect(message).toContain(`pro（${PRO.id}）：1K/1.5K/2K`)
    // Nothing was submitted: a refused pairing must cost nothing.
    expect(jobs.started).toHaveLength(0)
    expect(provider.inputs).toHaveLength(0)
  })

  it('still teaches when the backend cannot list its models', async () => {
    const provider = new CapableImageProvider({ [LITE.id]: LITE }, [])
    const { ctx } = await boot(provider)

    const result = await callImage(ctx, { prompt: 'a red panda', resolution: '1K' })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('2K/3K/4K')
    expect(result.error?.message).toContain(LITE.id)
  })

  it('refuses more reference images than the running model takes', async () => {
    const provider = new CapableImageProvider({ [LITE.id]: LITE, [PRO.id]: PRO })
    const { ctx, jobs } = await boot(provider)

    const tooMany = await callImage(ctx, {
      prompt: 'a montage',
      refImages: Array.from({ length: 15 }, (_, i) => `https://cdn/${i}.png`),
    })
    expect(tooMany.isError).toBe(true)
    expect(tooMany.error?.message).toContain('14')
    expect(jobs.started).toHaveLength(0)
  })

  it('lets a provider that states no capability behave exactly as before', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-media-cap-'))
    try {
      const provider = new OpaqueImageProvider()
      const { ctx, jobs } = await boot(provider)

      const result = await callImage(ctx, { prompt: 'a red panda' }, workspace)
      expect(result.isError).toBe(false)
      await jobs.hooks[0]!.done

      // No invented default tier, no fabricated model override.
      expect(provider.inputs[0]!.resolution).toBeUndefined()
      expect(provider.inputs[0]!.model).toBeUndefined()

      const outcome = await jobs.hooks[0]!.done as { output: string }
      // The echo still names the model that ran; the tier stays absent rather
      // than being guessed from a backend that never stated one.
      expect(JSON.parse(outcome.output).run).toEqual({ model: 'opaque-v1' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('uses the active row\u2019s stored tier when the call names none, and the row\u2019s model for capability', async () => {
    const provider = new CapableImageProvider(
      { [LITE.id]: LITE, [PRO.id]: PRO },
      [LITE.id, PRO.id],
      PRO.id,
    )
    const { ctx, jobs } = await boot(provider, {
      ns: MEDIA_SETTINGS_NAMESPACE,
      value: storedImageRow({ id: 'default:image', adapter: 'stub-capable', model: PRO.id, resolution: '1.5K' }),
    })

    await callImage(ctx, { prompt: 'a red panda' })
    await jobs.hooks[0]!.done
    expect(provider.inputs[0]).toMatchObject({ resolution: '1.5K' })
    expect(provider.inputs[0]!.model).toBeUndefined()
  })

  it('refuses a stored tier the serving model cannot serve, rather than moving it', async () => {
    // A document older than the vendor's model list: the row stores 1.5K while
    // the model it now points at is the lite class. The stored tier cannot
    // outlive the model it was chosen for, and nothing is substituted for it.
    const provider = new CapableImageProvider({ [LITE.id]: LITE, [PRO.id]: PRO })
    const { ctx, jobs } = await boot(provider, {
      ns: MEDIA_SETTINGS_NAMESPACE,
      value: storedImageRow({ id: 'default:image', adapter: 'stub-capable', model: '', resolution: '1.5K' }),
    })

    const result = await callImage(ctx, { prompt: 'a red panda' })
    expect(result.isError).toBe(true)
    expect(result.error?.message ?? '').toContain('1.5K')
    expect(jobs.started).toHaveLength(0)
    expect(provider.inputs).toHaveLength(0)
  })

  it('keeps the schema free of a tier list and points at the capability instead', async () => {
    const provider = new CapableImageProvider({ [LITE.id]: LITE, [PRO.id]: PRO })
    const { ctx } = await boot(provider)

    const schema = ctx.tools.schemas().find((candidate) => candidate.name === 'generate_image')
    const properties = (schema!.parameters as { properties: Record<string, Record<string, unknown>> }).properties
    expect(properties['resolution']).toMatchObject({ type: 'string' })
    expect(properties['resolution']).not.toHaveProperty('enum')
    expect(String(properties['resolution']?.['description'])).toContain('PER MODEL')
    expect(String(schema!.description)).toContain('per-model capability')
  })
})
