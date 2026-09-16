/**
 * Where the gate sits, proven rather than asserted.
 *
 * The gate's judgement is covered in `gate.spec.ts`. What this file proves is
 * the part that actually matters to the user: that a refusal happens **before
 * the provider is asked to do anything**. The stub providers here record every
 * call, so `inputs.length === 0` is the whole claim — the paid call was never
 * made, and the way to verify that is to count the calls rather than read a log.
 *
 * Nothing in this file touches the network.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ImageProvider, MediaRuntimeLocal, VideoProvider } from '../src/index.ts'
import type {
  ImageCaps,
  ImageGenerateInput,
  ImageGenerationResult,
  ProviderProbeResult,
  VideoCaps,
  VideoGenerateInput,
  VideoGenerationResult,
  VideoTaskHandle,
  VideoTaskPoll,
} from '../src/index.ts'
import { registerGenerateImage } from '../src/tools/generate-image.ts'
import { registerGenerateVideo } from '../src/tools/generate-video.ts'

const testToolSignal = new AbortController().signal

/** Records every generate() call; the count is the proof. */
class RecordingImageProvider extends ImageProvider {
  readonly provider = 'recording-image'
  readonly defaultModel = 'recording-image-v1'
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
    return 0.009
  }
  async probe(): Promise<ProviderProbeResult> {
    return { status: 'ok', message: 'stub' }
  }
  async testConnection(): Promise<boolean> {
    return true
  }
}

/** Records every submit() call; the count is the proof. */
class RecordingVideoProvider extends VideoProvider {
  readonly provider = 'recording-video'
  readonly defaultModel = 'recording-video-v1'
  inputs: VideoGenerateInput[] = []
  async submit(input: VideoGenerateInput): Promise<VideoTaskHandle> {
    this.inputs.push(input)
    return { taskId: 'task-1', poll: async (): Promise<VideoTaskPoll> => ({ status: 'running' }) }
  }
  async finalize(): Promise<VideoGenerationResult> {
    return {
      kind: 'video',
      attachmentRef: 'att:video',
      mediaType: 'video/mp4',
      mediaRef: { url: 'https://cdn.example/v.mp4', mediaType: 'video/mp4', expiresAt: Date.now() + 60_000 },
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

/** Minimal jobs registry: records that a job was started, and runs its hook. */
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
  read(): { text: string } {
    return { text: '' }
  }
}

const MANIFEST = [
  '# 演示项目 资产库',
  '### ST001_风格锁',
  '| CH001 | 主角 | 主角 | 围裙 | 无 | 定稿 | `01_角色/CH001` |',
  '| SC001 | 厨房 | 全片 | 木桌 | 无 | 定稿 | `02_场景/SC001` |',
].join('\n')

/**
 * A session workspace whose `.assets/<project>/` holds a real manifest and a
 * laid-out canvas. Both, because image generation is only paid for once the
 * batch has been laid out — a manifest without a canvas is refused.
 */
async function workspaceWithManifest(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'gate-hook-'))
  const dir = join(workspace, '.assets', '演示项目')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '演示项目_资产库.md'), MANIFEST)
  await writeFile(join(dir, 'canvas-blueprint.json'), '{"nodes":[],"connections":[]}')
  return workspace
}

const agentOf = (cwd: string) => ({ session: { header: { cwd } } }) as never

async function boot(): Promise<{
  ctx: Context
  jobs: StubJobs
  image: RecordingImageProvider
  video: RecordingVideoProvider
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const runtime = new MediaRuntimeLocal(ctx)
  const image = new RecordingImageProvider()
  const video = new RecordingVideoProvider()
  runtime.registerImageProvider(image)
  runtime.registerVideoProvider(video)
  const jobs = new StubJobs()
  ctx.provide('jobs', jobs)
  registerGenerateImage(ctx)
  registerGenerateVideo(ctx)
  return { ctx, jobs, image, video }
}

describe('the gate is the last thing before money is spent', () => {
  it('refuses an undeclared asset without starting a job or calling the provider', async () => {
    const { ctx, jobs, image } = await boot()
    const workspace = await workspaceWithManifest()

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('gate-img-blocked'),
      name: 'generate_image',
      arguments: { prompt: '画一格', project: '演示项目', label: 'KF03_格3_奶奶出门' },
      agent: agentOf(workspace),
    } as never)

    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('KF03')
    // The whole point: nothing downstream ran.
    expect(image.inputs).toHaveLength(0)
    expect(jobs.started).toHaveLength(0)
  })

  it('lets a declared asset through to the provider', async () => {
    const { ctx, jobs, image } = await boot()
    const workspace = await workspaceWithManifest()

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('gate-img-allowed'),
      name: 'generate_image',
      arguments: { prompt: '画一格', project: '演示项目', label: 'SC001_厨房母版' },
      agent: agentOf(workspace),
    } as never)

    expect(result.isError).toBe(false)
    expect(jobs.started).toHaveLength(1)
    // The job hook owns the provider call; awaiting it is what actually spends.
    await jobs.hooks[0]!.done
    expect(image.inputs).toHaveLength(1)
  })

  it('marks a call that names no asset, rather than refusing it', async () => {
    const { ctx, jobs, image } = await boot()
    const workspace = await workspaceWithManifest()

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('gate-img-unlabelled'),
      name: 'generate_image',
      arguments: { prompt: '封面主图', project: '演示项目', label: '封面主图' },
      agent: agentOf(workspace),
    } as never)

    expect(result.isError).toBe(false)
    expect(jobs.started).toHaveLength(1)
    await jobs.hooks[0]!.done
    expect(image.inputs).toHaveLength(1)
  })

  it('refuses a video submit the same way, before the provider is asked', async () => {
    const { ctx, jobs, video } = await boot()
    const workspace = await workspaceWithManifest()

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('gate-vid-blocked'),
      name: 'generate_video',
      arguments: { prompt: '一段', model: 'recording-video-v1', project: '演示项目', label: 'KF07_格7' },
      agent: agentOf(workspace),
    } as never)

    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('KF07')
    expect(video.inputs).toHaveLength(0)
    expect(jobs.started).toHaveLength(0)
  })

  it('marks a call with no project name instead of refusing it', async () => {
    const { ctx, jobs, video } = await boot()
    const workspace = await workspaceWithManifest()

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('gate-vid-noproject'),
      name: 'generate_video',
      arguments: { prompt: '一段', model: 'recording-video-v1' },
      agent: agentOf(workspace),
    } as never)

    expect(result.isError).toBe(false)
    expect(jobs.started).toHaveLength(1)
    // `submit` is awaited inside execute, so the provider already saw the call —
    // no need to await `done`, which a still-running stub would never settle.
    expect(video.inputs).toHaveLength(1)
  })

  it('leaves a project with no manifest alone, so early-stage work is not blocked', async () => {
    const { ctx, jobs, image } = await boot()
    const workspace = await mkdtemp(join(tmpdir(), 'gate-hook-empty-'))

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('gate-img-nomanifest'),
      name: 'generate_image',
      arguments: { prompt: '试三种风格', project: '刚立项', label: '风格对照_款1' },
      agent: agentOf(workspace),
    } as never)

    expect(result.isError).toBe(false)
    expect(jobs.started).toHaveLength(1)
    await jobs.hooks[0]!.done
    expect(image.inputs).toHaveLength(1)
  })
})
