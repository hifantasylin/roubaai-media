/**
 * Provider routing: the Settings page picks a backend per category by naming
 * its adapter, and the tools must send the call to that provider rather than to
 * whichever one the composition happened to register first.
 *
 * The compatibility rule these specs pin: a deployment with no settings
 * document — or one whose rows predate adapters — keeps resolving to the
 * registry default, which is the single-provider behavior every existing
 * install has.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ImageProvider, MEDIA_SETTINGS_NAMESPACE, MediaRuntimeLocal, readActiveAdapter } from '../src/index.ts'
import { registerGenerateImage } from '../src/tools/generate-image.ts'
import type { ImageGenerateInput, ImageGenerationResult } from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** One stored provider row; `adapter` omitted models a pre-adapter document. */
function storedEntry(id: string, adapter?: string): Record<string, unknown> {
  return {
    id,
    name: '',
    custom: false,
    ...adapter === undefined ? {} : { adapter },
    baseUrl: '',
    model: '',
  }
}

/** One stored category with its rows and the row in use. */
function storedCategory(activeId: string, providers: Record<string, unknown>[]): Record<string, unknown> {
  return { activeId, providers }
}

/** The minimal settings-service face `readActiveAdapter` consumes. */
function settingsService(ns: string, value: unknown): { describe(): { ns: string; value: unknown }[] } {
  return { describe: () => [{ ns, value }] }
}

/** An image provider that records every input it is handed. */
class RecordingImageProvider extends ImageProvider {
  readonly defaultModel = 'stub-model'
  inputs: ImageGenerateInput[] = []
  constructor(readonly provider: string) {
    super()
  }
  async generate(input: ImageGenerateInput): Promise<ImageGenerationResult> {
    this.inputs.push(input)
    return {
      kind: 'image',
      attachmentRef: 'att:generated',
      mediaType: 'image/png',
      providerMeta: { provider: this.provider, model: this.defaultModel },
    }
  }
  async testConnection(): Promise<boolean> {
    return true
  }
}

/** Minimal jobs registry exposing the started run hooks. */
class StubJobs {
  hooks: Array<{ cancel: (reason?: string) => void; done: Promise<unknown> }> = []
  start(spec: { run: () => { cancel: (reason?: string) => void; done: Promise<unknown> } }): string {
    this.hooks.push(spec.run())
    return 'job-1'
  }
  onJobDone(): () => void {
    return () => {}
  }
  reportProgress(): void {}
}

/** Boot a context with the given image adapters and optional stored settings. */
async function boot(options: {
  adapters: readonly string[]
  settings?: { ns: string; value: unknown }
}): Promise<{ ctx: Context; jobs: StubJobs; providers: RecordingImageProvider[] }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const runtime = new MediaRuntimeLocal(ctx)
  const providers = options.adapters.map(name => new RecordingImageProvider(name))
  for (const provider of providers) runtime.registerImageProvider(provider)
  const jobs = new StubJobs()
  ctx.provide('jobs', jobs)
  if (options.settings !== undefined) {
    ctx.provide('settings', settingsService(options.settings.ns, options.settings.value))
  }
  registerGenerateImage(ctx)
  return { ctx, jobs, providers }
}

describe('readActiveAdapter', () => {
  it('returns undefined when the deployment runs without a settings service', async () => {
    const { ctx } = await boot({ adapters: ['stub-a'] })
    expect(readActiveAdapter(ctx, 'image')).toBeUndefined()
  })

  it('returns undefined for a row stored before adapters existed', async () => {
    const { ctx } = await boot({
      adapters: ['stub-a'],
      settings: {
        ns: MEDIA_SETTINGS_NAMESPACE,
        value: { image: storedCategory('a', [storedEntry('a')]), keys: {} },
      },
    })
    expect(readActiveAdapter(ctx, 'image')).toBeUndefined()
  })

  it('returns the active row\u2019s adapter', async () => {
    const { ctx } = await boot({
      adapters: ['stub-a'],
      settings: {
        ns: MEDIA_SETTINGS_NAMESPACE,
        value: { image: storedCategory('a', [storedEntry('a', 'stub-a')]), keys: {} },
      },
    })
    expect(readActiveAdapter(ctx, 'image')).toBe('stub-a')
  })

  it('follows activeId to the selected row rather than the first one', async () => {
    const { ctx } = await boot({
      adapters: ['stub-a', 'stub-b'],
      settings: {
        ns: MEDIA_SETTINGS_NAMESPACE,
        value: {
          image: storedCategory('b', [storedEntry('a', 'stub-a'), storedEntry('b', 'stub-b')]),
          keys: {},
        },
      },
    })
    expect(readActiveAdapter(ctx, 'image')).toBe('stub-b')
  })

  it('returns undefined for a namespace the document does not carry', async () => {
    const { ctx } = await boot({
      adapters: ['stub-a'],
      settings: {
        ns: MEDIA_SETTINGS_NAMESPACE,
        value: { image: storedCategory('a', [storedEntry('a', 'stub-a')]), keys: {} },
      },
    })
    expect(readActiveAdapter(ctx, 'image', 'some-other-namespace')).toBeUndefined()
  })
})

describe('generate_image provider routing', () => {
  it('sends the call to the provider the settings page activated', async () => {
    const { ctx, jobs, providers } = await boot({
      adapters: ['stub-a', 'stub-b'],
      settings: {
        ns: MEDIA_SETTINGS_NAMESPACE,
        value: {
          image: storedCategory('b', [storedEntry('a', 'stub-a'), storedEntry('b', 'stub-b')]),
          keys: {},
        },
      },
    })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('img-route'),
      name: 'generate_image',
      arguments: { prompt: 'a red panda' },
    })

    expect(result.isError).toBe(false)
    await jobs.hooks[0]!.done
    expect(providers[0]!.inputs).toHaveLength(0)
    expect(providers[1]!.inputs).toHaveLength(1)
  })

  it('keeps the first registered provider when nothing is configured', async () => {
    const { ctx, jobs, providers } = await boot({ adapters: ['stub-a', 'stub-b'] })

    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('img-default'),
      name: 'generate_image',
      arguments: { prompt: 'a red panda' },
    })

    await jobs.hooks[0]!.done
    expect(providers[0]!.inputs).toHaveLength(1)
    expect(providers[1]!.inputs).toHaveLength(0)
  })

  it('denies when the activated adapter is not registered', async () => {
    const { ctx } = await boot({
      adapters: ['stub-a'],
      settings: {
        ns: MEDIA_SETTINGS_NAMESPACE,
        value: { image: storedCategory('a', [storedEntry('a', 'not-mounted')]), keys: {} },
      },
    })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('img-missing'),
      name: 'generate_image',
      arguments: { prompt: 'a red panda' },
    })

    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/no image provider/)
  })
})
