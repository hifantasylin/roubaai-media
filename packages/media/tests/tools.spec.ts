import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MediaRuntimeLocal } from '../src/index.ts'
import { ImageProvider, VideoProvider } from '../src/index.ts'
import { ledgerPath } from '../src/cost-ledger.ts'
import { registerGenerateImage } from '../src/tools/generate-image.ts'
import { registerGenerateVideo } from '../src/tools/generate-video.ts'
import type {
  ImageGenerateInput,
  ImageGenerationResult,
  VideoGenerateInput,
  VideoGenerationResult,
  VideoTaskHandle,
  VideoTaskPoll,
} from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** A recorded image provider that returns a canned result. */
class StubImageProvider extends ImageProvider {
  readonly provider = 'stub-image'
  readonly defaultModel = 'stub-image-v1'
  /**
   * The model the result reports when the run used something other than the
   * configured default — a Settings-page override, say. Unset means "ran the
   * default", the ordinary case.
   */
  reportedModel?: string
  inputs: ImageGenerateInput[] = []
  async generate(input: ImageGenerateInput): Promise<ImageGenerationResult> {
    this.inputs.push(input)
    return {
      kind: 'image',
      attachmentRef: 'att:generated',
      attachment: {
        attachmentId: 'att:generated' as never,
        mediaType: 'image/png',
        bytes: 1,
        width: 1,
        height: 1,
      },
      mediaType: 'image/png',
      providerMeta: { provider: this.provider, model: this.reportedModel ?? this.defaultModel },
    }
  }
  async testConnection(): Promise<boolean> {
    return true
  }
}

/** A recorded video provider returning a pollable handle. */
class StubVideoProvider extends VideoProvider {
  readonly provider = 'stub-video'
  readonly defaultModel: string
  inputs: VideoGenerateInput[] = []
  constructor(defaultModel = 'stub-video-v1') {
    super()
    this.defaultModel = defaultModel
  }
  /** Poll results served in order; falls back to `running` when exhausted. */
  pollResults: VideoTaskPoll[] = []
  async submit(input: VideoGenerateInput): Promise<VideoTaskHandle> {
    this.inputs.push(input)
    const pollResults = this.pollResults
    return {
      taskId: 'task-1',
      poll: async (): Promise<VideoTaskPoll> => pollResults.shift() ?? { status: 'running' },
    }
  }
  async finalize(_handle: VideoTaskHandle): Promise<VideoGenerationResult> {
    return {
      kind: 'video',
      attachmentRef: 'att:video',
      mediaType: 'video/mp4',
      mediaRef: {
        url: 'https://cdn.example/v.mp4',
        mediaType: 'video/mp4',
        expiresAt: Date.now() + 24 * 60 * 60_000,
      },
      providerMeta: { provider: this.provider, model: this.defaultModel, taskId: 'task-1' },
    }
  }
  async testConnection(): Promise<boolean> {
    return true
  }
}

/** Minimal jobs registry: records the started spec and exposes the run hooks. */
class StubJobs {
  started: Array<{ kind: string; label: string }> = []
  hooks: Array<{ cancel: (reason?: string) => void; done: Promise<unknown> }> = []
  readonly doneListeners: Array<(snapshot: unknown, owner: unknown) => void> = []
  start(spec: { kind: string; label: string; run: () => { cancel: (reason?: string) => void; done: Promise<unknown> } }): string {
    this.started.push({ kind: spec.kind, label: spec.label })
    this.hooks.push(spec.run())
    return 'job-1'
  }
  onJobDone(listener: (snapshot: unknown, owner: unknown) => void): () => void {
    this.doneListeners.push(listener)
    return () => {
      const i = this.doneListeners.indexOf(listener)
      if (i >= 0) this.doneListeners.splice(i, 1)
    }
  }
  reportProgress(): void {}
  readText = ''
  read(): { text: string } {
    return { text: this.readText }
  }
}

async function boot(model = 'stub-video-v1'): Promise<{
  ctx: Context
  jobs: StubJobs
  image: StubImageProvider
  video: StubVideoProvider
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  // Provide `ctx.media` and `ctx.jobs` before registering the tools.
  const runtime = new MediaRuntimeLocal(ctx)
  const image = new StubImageProvider()
  const video = new StubVideoProvider(model)
  runtime.registerImageProvider(image)
  runtime.registerVideoProvider(video)

  const jobs = new StubJobs()
  ctx.provide('jobs', jobs)

  registerGenerateImage(ctx)
  registerGenerateVideo(ctx)

  return { ctx, jobs, image, video }
}

describe('generate_image tool', () => {
  it('exposes the parameter schema with enums and required prompt', async () => {
    const { ctx } = await boot()
    const schema = ctx.tools.schemas().find(s => s.name === 'generate_image')
    expect(schema).toBeDefined()
    const properties = (schema!.parameters as { properties: Record<string, unknown> }).properties
    expect(properties.prompt).toMatchObject({ type: 'string' })
    expect(properties.aspectRatio).toMatchObject({ enum: ['1:1', '16:9', '9:16', '4:3', '3:4'] })
    expect(properties.resolution).toMatchObject({ enum: ['1K', '2K', '4K'] })
    expect(properties.quality).toMatchObject({ enum: ['low', 'medium', 'high'] })
  })

  it('executes, forwards args to the provider, and returns the background canonical value', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-media-image-'))
    try {
      const { ctx, jobs, image } = await boot()
      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId('img-1'),
        name: 'generate_image',
        arguments: { prompt: 'a red panda', resolution: '2K' },
        // The completed job appends the cost ledger under the agent's cwd.
        agent: { session: { header: { cwd: workspace } } } as never,
      })

      expect(result.isError).toBe(false)
      expect(result.value).toEqual({
        kind: 'background',
        jobId: 'job-1',
        taskId: 'stub-image',
      })

      // The job was started synchronously with the media-image kind.
      expect(jobs.started).toEqual([{ kind: 'media-image', label: 'generate_image:stub-image' }])

      // The provider runs inside the background done fiber; await it to observe
      // the forwarded input.
      await jobs.hooks[0]!.done
      expect(image.inputs).toHaveLength(1)
      expect(image.inputs[0]!.prompt).toBe('a red panda')
      expect(image.inputs[0]!.resolution).toBe('2K')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('surfaces NO_PROVIDER when no image provider is registered', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // Media runtime present but no image provider registered.
    new MediaRuntimeLocal(ctx)
    ctx.provide('jobs', new StubJobs())
    registerGenerateImage(ctx)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('img-np'),
      name: 'generate_image',
      arguments: { prompt: 'anything', model: 'doubao-seedance-2.0-mini' },
    })

    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/no image provider/)
  })

  it('ledgers the model the result reports, not the provider default', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-media-image-cost-'))
    try {
      const { ctx, jobs, image } = await boot()
      // A Settings-page override makes the run's model differ from the
      // provider's configured default. The ledger must name what actually ran:
      // billing the default's rate for another model's generation is the whole
      // reason the result carries the model it used.
      image.reportedModel = 'stub-image-override'
      await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId('img-cost'),
        name: 'generate_image',
        arguments: { prompt: 'a red panda', resolution: '1K' },
        agent: { session: { header: { cwd: workspace } } } as never,
      })
      await jobs.hooks[0]!.done

      const lines = (await readFile(ledgerPath(workspace, workspace), 'utf8'))
        .split('\n')
        .filter(line => line.trim().length > 0)
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toMatchObject({
        tool: 'image',
        model: 'stub-image-override',
        spec: '1K',
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('generate_video tool', () => {
  it('exposes the parameter schema with duration/resolution/size enums', async () => {
    const { ctx } = await boot()
    const schema = ctx.tools.schemas().find(s => s.name === 'generate_video')
    expect(schema).toBeDefined()
    const properties = (schema!.parameters as { properties: Record<string, unknown> }).properties
    expect(properties.prompt).toMatchObject({ type: 'string' })
    expect(properties.model).toMatchObject({ enum: ['doubao-seedance-2.0-mini', 'doubao-seedance-2.0-fast', 'doubao-seedance-2.0', 'doubao-seedance-2.5'] })
    expect(properties.duration).toMatchObject({ type: 'integer' })
    expect(properties.resolution).toMatchObject({ enum: ['480p', '720p', '1080p'] })
    expect(properties.size).toMatchObject({ enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'] })
    expect(properties.generateAudio).toMatchObject({ type: 'boolean' })
    expect(properties.returnLastFrame).toMatchObject({ type: 'boolean' })
    expect(properties.audioUrls).toMatchObject({ type: 'array' })
    expect(properties.imageWithRoles).toMatchObject({ type: 'array' })
    expect(properties.generationType).toMatchObject({ enum: ['reference', 'video_edit'] })
    expect(properties.outputFormat).toMatchObject({ enum: ['mp4', 'mov'] })
    expect(properties.callbackUrl).toMatchObject({ type: 'string' })
    expect(properties.watermark).toMatchObject({ type: 'boolean' })
  })

  it('submits the job synchronously and returns the background canonical value', async () => {
    const { ctx, jobs, video } = await boot()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-1'),
      name: 'generate_video',
      arguments: { prompt: 'a running horse', model: 'doubao-seedance-2.0-mini', duration: 8 },
    })

    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      kind: 'background',
      jobId: 'job-1',
      taskId: 'task-1',
    })

    // The job was started synchronously with the media-video kind.
    expect(jobs.started).toEqual([{ kind: 'media-video', label: 'generate_video:task-1' }])

    // The provider received the defaulted/forwarded input.
    expect(video.inputs).toHaveLength(1)
    expect(video.inputs[0]!.prompt).toBe('a running horse')
    expect(video.inputs[0]!.duration).toBe(8)
  })

  it('applies the default duration when omitted', async () => {
    const { ctx, video } = await boot()
    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-def'),
      name: 'generate_video',
      arguments: { prompt: 'a sunrise', model: 'doubao-seedance-2.0-mini' },
    })
    expect(video.inputs[0]!.duration).toBe(5)
  })

  it('rejects an out-of-range duration for a non-2.5 model (Seedance 2.0 cap 15s)', async () => {
    const { ctx, video } = await boot()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-dur'),
      name: 'generate_video',
      arguments: { prompt: 'a sunrise', model: 'doubao-seedance-2.0-mini', duration: 60 },
    })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/4 through 15/)
    expect(video.inputs).toHaveLength(0)
  })

  it('rejects more than three reference videos for a non-2.5 model (Seedance 2.0 cap 3)', async () => {
    const { ctx, video } = await boot()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-urls'),
      name: 'generate_video',
      arguments: { prompt: 'a montage', model: 'doubao-seedance-2.0-mini', videoUrls: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11'] },
    })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/at most 3/)
    expect(video.inputs).toHaveLength(0)
  })

  it('rejects imageUrls combined with imageWithRoles, and imageWithRoles combined with videoUrls/audioUrls', async () => {
    const { ctx, video } = await boot()
    const exclusive = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-iwr-ex'),
      name: 'generate_video',
      arguments: { prompt: 'x', model: 'doubao-seedance-2.0-mini', imageUrls: ['u1'], imageWithRoles: [{ role: 'first_frame', image_url: 'u2' }] },
    })
    expect(exclusive.isError).toBe(true)
    expect(exclusive.error?.message).toMatch(/mutually exclusive/)

    const withVideos = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-iwr-vid'),
      name: 'generate_video',
      arguments: { prompt: 'x', model: 'doubao-seedance-2.0-mini', imageWithRoles: [{ role: 'first_frame', image_url: 'u1' }], videoUrls: ['v1'] },
    })
    expect(withVideos.isError).toBe(true)
    expect(withVideos.error?.message).toMatch(/cannot be combined/)

    expect(video.inputs).toHaveLength(0)
  })

  it('forwards imageWithRoles and callbackUrl to the provider input', async () => {
    const { ctx, video } = await boot('doubao-seedance-2.5')
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-iwr-fwd'),
      name: 'generate_video',
      arguments: {
        prompt: 'a handover',
        model: 'doubao-seedance-2.5',
        imageWithRoles: [{ role: 'first_frame', image_url: 'https://cdn/f.png' }],
        callbackUrl: 'https://hook.example/done',
      },
    })
    expect(result.isError).toBe(false)
    expect(video.inputs).toHaveLength(1)
    expect(video.inputs[0]!.imageWithRoles).toEqual([{ role: 'first_frame', image_url: 'https://cdn/f.png' }])
    expect(video.inputs[0]!.callbackUrl).toBe('https://hook.example/done')
  })

  it('honors an explicit model argument over the provider default (caps + passthrough)', async () => {
    // stub 默认非 2.5（4-15s/3 视频），但显式传 2.5 时按 2.5 上限放行并透传
    const { ctx, video } = await boot()
    const ok = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-model-25'),
      name: 'generate_video',
      arguments: { prompt: 'a long take', model: 'doubao-seedance-2.5', duration: 30, videoUrls: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10'] },
    })
    expect(ok.isError).toBe(false)
    expect(video.inputs).toHaveLength(1)
    expect(video.inputs[0]!.model).toBe('doubao-seedance-2.5')
    expect(video.inputs[0]!.duration).toBe(30)
    expect(video.inputs[0]!.videoUrls).toHaveLength(10)
  })

  it('uses Seedance 2.5 caps (4-30s, 10 videos, 10 audio) when the provider model is 2.5', async () => {
    const { ctx, video } = await boot('doubao-seedance-2.5')
    const ok = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-25-ok'),
      name: 'generate_video',
      arguments: { prompt: 'a long take', model: 'doubao-seedance-2.5', duration: 30, videoUrls: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10'], audioUrls: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10'] },
    })
    expect(ok.isError).toBe(false)

    const tooLong = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-25-long'),
      name: 'generate_video',
      arguments: { prompt: 'too long', model: 'doubao-seedance-2.5', duration: 31 },
    })
    expect(tooLong.isError).toBe(true)
    expect(tooLong.error?.message).toMatch(/4 through 30/)

    const tooManyVideos = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-25-vids'),
      name: 'generate_video',
      arguments: { prompt: 'too many', model: 'doubao-seedance-2.5', videoUrls: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11'] },
    })
    expect(tooManyVideos.isError).toBe(true)
    expect(tooManyVideos.error?.message).toMatch(/at most 10/)

    const tooManyAudio = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-25-audio'),
      name: 'generate_video',
      arguments: { prompt: 'too many audio', model: 'doubao-seedance-2.5', audioUrls: Array.from({ length: 11 }, (_, i) => `a${i + 1}`) },
    })
    expect(tooManyAudio.isError).toBe(true)
    expect(tooManyAudio.error?.message).toMatch(/at most 10 reference audio/)
    expect(video.inputs).toHaveLength(1)
  })

  it('denies through the monotonic guard when no video provider is registered (NO_PROVIDER)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // Media runtime present but no video provider registered.
    new MediaRuntimeLocal(ctx)
    ctx.provide('jobs', new StubJobs())
    registerGenerateVideo(ctx)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-np'),
      name: 'generate_video',
      arguments: { prompt: 'anything', model: 'doubao-seedance-2.0-mini' },
    })

    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(/no video provider is configured/)
  })

  it('returns synchronous { cancel, done } hooks from run() and completes on succeeded poll', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-media-video-'))
    try {
      const { ctx, jobs, video } = await boot()
      video.pollResults = [{ status: 'succeeded', resultUrl: 'https://cdn/v.mp4' }]

      await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId('vid-ok'),
        name: 'generate_video',
        arguments: { prompt: 'a horse', model: 'doubao-seedance-2.0-mini' },
        // The completed job appends the cost ledger under the agent's cwd (and
        // the stub CDN URL simply fails the cache fast path).
        agent: { session: { header: { cwd: workspace } } } as never,
      })

      // run() returned the hooks synchronously.
      expect(jobs.hooks).toHaveLength(1)
      expect(typeof jobs.hooks[0]!.cancel).toBe('function')
      expect(jobs.hooks[0]!.done).toBeInstanceOf(Promise)

      // The done promise resolves to a completed JobOutcome carrying the task id.
      const outcome = await jobs.hooks[0]!.done
      expect(outcome).toMatchObject({ status: 'completed' })
      expect(JSON.parse((outcome as { output: string }).output)).toMatchObject({
        kind: 'video',
        providerMeta: { taskId: 'task-1' },
        mediaRef: { url: 'https://cdn.example/v.mp4' },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('resolves done to a failed JobOutcome on a failed poll', async () => {
    const { ctx, jobs, video } = await boot()
    video.pollResults = [{ status: 'failed', errorMsg: 'content violation' }]

    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-fail'),
      name: 'generate_video',
      arguments: { prompt: 'a horse', model: 'doubao-seedance-2.0-mini' },
    })

    const outcome = await jobs.hooks[0]!.done
    expect(outcome).toEqual({
      status: 'failed',
      detail: 'video generation FAILED: content violation — 生成失败（可能已产生费用）；请用户确认后再决定是否重新生成',
    })
  })

  it('cancels through its own AbortController, resolving done to killed', async () => {
    const { ctx, jobs, video } = await boot()
    // The poll keeps returning running so the loop blocks in sleep; the cancel
    // aborts the loop's own controller (decoupled from exec.signal).
    video.pollResults = [{ status: 'running' }]

    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('vid-kill'),
      name: 'generate_video',
      arguments: { prompt: 'a horse', model: 'doubao-seedance-2.0-mini' },
    })

    const hooks = jobs.hooks[0]!
    hooks.cancel('user asked to stop')

    const outcome = await hooks.done
    expect(outcome).toEqual({ status: 'killed' })
  })

  it('onJobDone registers no completion listener: results are read through job_output only', async () => {
    const { jobs } = await boot()

    // The media tools push no queued-message followups — a completion message
    // piles up in the session tray and forces extra model turns.
    expect(jobs.doneListeners.length).toBe(0)
  })
})
