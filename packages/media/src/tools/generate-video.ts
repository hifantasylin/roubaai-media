/**
 * `generate_video` tool: text-to-video / image-to-video via a configured media
 * provider, run as a `ctx.jobs` background task (video generation takes 1-5
 * minutes and must not block the foreground `execute`).
 *
 * The foreground call only submits the task and publishes the job id; the
 * background `run()` owns a self-built `AbortController` and polls the
 * provider handle until a terminal state, reporting `completed`/`killed`/
 * `failed` through `JobHooks.done`. Billing-sensitive: `videoUrls` stack
 * reference-video billing, `generateAudio`/`returnLastFrame` add extra output
 * — all are capped here and surfaced through the guard.
 *
 * @module @roubaai/media/tools/generate-video
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { VideoCaps, VideoGenerateInput, VideoGenerationResult, VideoTaskPoll } from '../provider.ts'
import { readActiveAdapter } from '../settings-lookup.ts'
import { appendMediaCost, DEFAULT_PROJECT } from '../cost-ledger.ts'
import { downloadToCache } from '../media-cache.ts'
import { primaryAssetsRoot, workspaceOfAgent } from '../asset-root.ts'

export const name = 'generate_video'

/** Poll interval between provider polls inside the background task. */
const POLL_INTERVAL_MS = 10_000

/** One-line error message for a thrown value (the job detail is model-readable). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Render `（HTTP xxx）` when the error carries an HTTP status (provider errors do). */
function errorStatusTag(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' && Number.isInteger(status) ? `（HTTP ${status}）` : ''
}

/**
 * End-to-end polling bound for a video task. Unlike image generation (which
 * has a provider-side `pollTimeoutMs`), video generation can take several
 * minutes and Maizi may leave a task `running` indefinitely on a server-side
 * stall. Without a bound the background job would poll forever and stay
 * `running` with no way out except a manual kill. 15 minutes covers normal
 * generation plus queue spikes; on expiry the job reports `failed` (retryable)
 * rather than hanging.
 */
const VIDEO_POLL_TIMEOUT_MS = 900_000

/** The default duration when the model omits one (Maizi default is 5). */
const DEFAULT_DURATION = 5

/** A `sleep` helper for the polling loop. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) {
      setTimeout(resolve, ms)
      return
    }
    // Abort resolves (rather than rejects) so the polling loop wakes early and
    // returns to the top, where `ac.signal.aborted` maps the cancel to a
    // `killed` JobOutcome — never a rejection.
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Validate value constraints the schema DSL does not express: the caps the
 * provider declares for the model being asked for, and the mutually exclusive
 * input combinations. The caps are billing guards — the model cannot inflate
 * the cost tier through an omitted or oversized field.
 */
function validateVideoArgs(args: {
  prompt: string
  model?: string
  imageUrls?: string[]
  imageWithRoles?: unknown[]
  videoUrls?: string[]
  audioUrls?: string[]
  duration?: number
  generateAudio?: boolean
  returnLastFrame?: boolean
}, model: string | undefined, caps: VideoCaps): void {
  if (args.prompt.trim().length === 0) {
    throw new Error('generate_video: prompt must be a non-empty string')
  }
  // image_with_roles 与 imageUrls 互斥；使用后不可再用 videoUrls/audioUrls。
  if (args.imageUrls !== undefined && args.imageWithRoles !== undefined) {
    throw new Error('generate_video: imageUrls and imageWithRoles are mutually exclusive')
  }
  if (args.imageWithRoles !== undefined && (args.videoUrls !== undefined || args.audioUrls !== undefined)) {
    throw new Error('generate_video: imageWithRoles cannot be combined with videoUrls or audioUrls')
  }
  if (args.duration !== undefined
    && (!Number.isInteger(args.duration) || args.duration < caps.minDuration || args.duration > caps.maxDuration)) {
    throw new Error(`generate_video: duration must be an integer from ${caps.minDuration} through ${caps.maxDuration}`)
  }
  if (args.imageUrls !== undefined && args.imageUrls.length > caps.maxImageUrls) {
    throw new Error(`generate_video: at most ${caps.maxImageUrls} reference images are allowed (model ${model ?? 'default'})`)
  }
  if (args.videoUrls !== undefined && args.videoUrls.length > caps.maxVideoUrls) {
    throw new Error(`generate_video: at most ${caps.maxVideoUrls} reference videos are allowed (model ${model ?? 'default'})`)
  }
  if (args.audioUrls !== undefined && args.audioUrls.length > caps.maxAudioUrls) {
    throw new Error(`generate_video: at most ${caps.maxAudioUrls} reference audio files are allowed (model ${model ?? 'default'})`)
  }
}

/**
 * Register the `generate_video` tool. `ctx.jobs.start` is synchronous and
 * returns a `JobId`; `run()` is synchronous and returns `{ cancel, done }`.
 * The background loop owns its own `AbortController`, decoupled from
 * `exec.signal` once the job id is published (per the background-job contract).
 */
export function registerGenerateVideo(ctx: Context): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name,
    description: 'Generate a short video (text-to-video / image-to-video / video_edit). Background job: returns a job id; read the completed result via job_output. The finished video is displayed automatically in the conversation as this job_output tool-result card (inline player) — do NOT paste its URL / JSON into your reply to "show" it, and never call read_image on a generated video. Persist with media_asset_save (reference = the job_output JSON or mediaRef.url) when the file must outlive the 24h URL expiry. Pass reference images via imageUrls (public https only). Caps come from the adapter serving the model (Maizi: 2.0 系 = 4-15s / 9 images / 3 videos / 3 audio; 2.5 = 4-30s / 30 / 10 / 10 + video_edit (size=adaptive) + outputFormat). COST per second (Maizi): 2.0-fast $0.0637 (480p) / $0.137 (720p); 2.0 standard $0.0792 / $0.1704; 2.5 $0.1201 / $0.27 (含视频输入更便宜 $0.072/$0.162). Prefer 480p and 4-5s to control cost; videoUrls stacks reference billing; generateAudio adds audio output.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Video prompt (1-4000 characters).' },
      // No enum: the accepted model ids depend on which adapter the deployment
      // mounted, and the Settings page selects the adapter — a schema cannot
      // enumerate a runtime configuration. The adapter validates the id and
      // names its own models when it rejects one.
      model: { type: 'string', required: true, description: '模型档位（必填）。取值随当前适配器：麦子科技用 doubao-seedance-2.0-mini / -fast / doubao-seedance-2.0 / doubao-seedance-2.5；火山方舟直连用方舟自己的 Model ID（如 doubao-seedance-2-0-mini-260615；方舟会更换与退役 id，实际可用列表以适配器报错时给出的为准）。填错时由适配器报错并列出可用模型。' },
      imageUrls: { type: 'array', items: { type: 'string' }, description: 'Optional reference image URLs (max 30; Seedance 2.0 上限 9). 与 imageWithRoles 互斥。' },
      imageWithRoles: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Role-tagged images (首帧/尾帧/参考图, 如 [{ role: "first_frame", image_url: "..." }]). 与 imageUrls 互斥; 使用后不可再用 videoUrls/audioUrls。' },
      videoUrls: { type: 'array', items: { type: 'string' }, description: 'Optional reference video URLs (max 10; Seedance 2.0 上限 3; stacks reference billing).' },
      audioUrls: { type: 'array', items: { type: 'string' }, description: 'Optional reference audio URLs (max 10; Seedance 2.5 能力).' },
      duration: { type: 'integer', description: 'Duration in seconds, 4-30, default 5 (Seedance 2.0 上限 15; 2.5 上限 30). Shorter costs less.' },
      size: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'], description: 'Aspect ratio; adaptive 仅用于 video_edit.' },
      resolution: { type: 'string', enum: ['480p', '720p', '1080p'], description: 'Resolution, default 720p. 480p is roughly half the 720p cost.' },
      generateAudio: { type: 'boolean', description: 'Generate an audio-carrying video (extra cost), default false.' },
      returnLastFrame: { type: 'boolean', description: 'Return the last frame for continuous video (extra output), default false.' },
      generationType: { type: 'string', enum: ['reference', 'video_edit'], description: 'Generation mode: reference (default) | video_edit (Seedance 2.5 视频编辑, 需 videoUrls + size=adaptive).' },
      outputFormat: { type: 'string', enum: ['mp4', 'mov'], description: 'Output container, default mp4 (Seedance 2.5).' },
      callbackUrl: { type: 'string', description: 'Task-terminal callback URL (生成完成后 POST 通知).' },
      watermark: { type: 'boolean', description: 'Add watermark, default false.' },
      project: { type: 'string', description: '成本记账用：当前项目名（如 奇幻超人），用于媒体成本账归档；不传则归到工作空间。' },
      label: { type: 'string', description: '成本记账用：本镜头标识（如 EP01_镜02_镇民躲藏）；同一 (project,label) 第二次出现自动记为重试。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'background' },
          jobId: { type: 'string', required: true },
          taskId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Started background video job ${value.jobId} (task ${value.taskId})` }],
    },
    async execute(args, exec) {
      // Route through the backend the Settings page activated for video. An
      // unconfigured deployment names none, and keeps whatever single provider
      // its composition registered — the behavior it has always had.
      const adapter = readActiveAdapter(ctx, 'video')
      const provider = adapter === undefined ? ctx.media.video() : ctx.media.video(adapter)
      // model 必填（schema 强制）：显式模型档位，杜绝静默落到 provider 默认 mini。
      const effectiveModel = args.model
      validateVideoArgs(args, effectiveModel, provider.caps(effectiveModel))
      const input: VideoGenerateInput = {
        prompt: args.prompt,
        model: args.model,
        ...args.imageUrls !== undefined ? { imageUrls: args.imageUrls } : {},
        ...args.imageWithRoles !== undefined ? { imageWithRoles: args.imageWithRoles } : {},
        ...args.videoUrls !== undefined ? { videoUrls: args.videoUrls } : {},
        ...args.audioUrls !== undefined ? { audioUrls: args.audioUrls } : {},
        duration: args.duration ?? DEFAULT_DURATION,
        ...args.size !== undefined ? { size: args.size } : {},
        ...args.resolution !== undefined ? { resolution: args.resolution } : {},
        ...args.generateAudio !== undefined ? { generateAudio: args.generateAudio } : {},
        ...args.returnLastFrame !== undefined ? { returnLastFrame: args.returnLastFrame } : {},
        ...args.generationType !== undefined ? { generationType: args.generationType } : {},
        ...args.outputFormat !== undefined ? { outputFormat: args.outputFormat } : {},
        ...args.callbackUrl !== undefined ? { callbackUrl: args.callbackUrl } : {},
        ...args.watermark !== undefined ? { watermark: args.watermark } : {},
      }
      const handle = await provider.submit(input, exec.signal)
      // Once the job id is published, work is owned by the task's own
      // cancellation signal, decoupled from `exec.signal`.
      const jobId = ctx.jobs.start({
        kind: 'media-video',
        label: `generate_video:${handle.taskId}`,
        ...exec.agent !== undefined ? { owner: exec.agent } : {},
        run: () => {
          const ac = new AbortController()
          const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS
          const done = (async (): Promise<JobOutcome> => {
            for (;;) {
              if (ac.signal.aborted) return { status: 'killed' }
              // A Maizi task left `running` on a server-side stall must not
              // keep this background job alive forever: bound the whole
              // generation and surface a retryable `failed` on expiry.
              if (Date.now() > deadline) {
                return { status: 'failed', detail: `video generation timed out after ${VIDEO_POLL_TIMEOUT_MS / 1000}s` }
              }
              // Poll and finalize are caught SEPARATELY so the job detail can
              // tell the model which stage failed and what a retry costs:
              //  - poll network failure: the Maizi task may still be running —
              //    re-polling is free, do NOT re-submit (re-billing).
              //  - finalize/download failure: generation already succeeded —
              //    only fetching the result failed, retry is free.
              //  - provider-side generation failure: billing may have occurred —
              //    require explicit user confirmation before re-submitting.
              let poll: VideoTaskPoll
              try {
                poll = await handle.poll(ac.signal)
              } catch (error) {
                return {
                  status: 'failed',
                  detail: `轮询网络失败：生成任务可能仍在后台运行，仅轮询中断；可重试轮询（${errorMessage(error)}）`,
                }
              }
              if (poll.status === 'succeeded') {
                let result: VideoGenerationResult
                try {
                  result = await provider.finalize(handle, ac.signal)
                } catch (error) {
                  return {
                    status: 'failed',
                    detail: `结果下载失败${errorStatusTag(error)}：视频已生成成功，拉取结果失败，可重试拉取（${errorMessage(error)}）`,
                  }
                }
                // Automatic cost accounting: prefer the provider-reported
                // costUsd, fall back to the rate-table estimate. A ledger write
                // failure must never fail the generation itself.
                try {
                  const assets = primaryAssetsRoot(workspaceOfAgent(exec.agent))
                  const reported = (result.providerMeta as { costUsd?: unknown } | undefined)?.costUsd
                  const reportedUsd = typeof reported === 'number' && Number.isFinite(reported) ? reported : undefined
                  const estimated = provider.estimateCostUsd(
                    result.providerMeta?.model ?? provider.defaultModel,
                    input.duration ?? DEFAULT_DURATION,
                    args.resolution ?? '720p',
                  )
                  await appendMediaCost(assets, {
                    ts: Date.now(),
                    tool: 'video',
                    model: result.providerMeta?.model ?? provider.defaultModel,
                    project: args.project ?? DEFAULT_PROJECT,
                    ...args.label !== undefined ? { label: args.label } : {},
                    spec: `${input.duration ?? DEFAULT_DURATION}s×${args.resolution ?? '720p'}`,
                    costUsd: reportedUsd ?? estimated ?? 0,
                    source: reportedUsd !== undefined ? 'reported' : 'estimated',
                    ...'taskId' in handle ? { taskId: (handle as { taskId: string }).taskId } : {},
                  })
                } catch (costError) {
                  ctx.logger.warn(`media cost ledger append failed: ${String(costError)}`)
                }
                // Cache the finished media locally BEFORE settling the job so
                // `job_output` already carries a same-origin signed stream URL
                // (`mediaRef.localUrl`): the player plays the local file
                // (fast, Range-seekable) and never touches the slow provider
                // CDN. Failure to cache only loses the fast path — the CDN URL
                // stays in `mediaRef.url` and the job still completes.
                const localUrl = await downloadToCache({
                  url: result.mediaRef.url,
                  mediaType: result.mediaRef.mediaType,
                  fallbackExt: 'mp4',
                  log: message => ctx.logger.warn(`[media-cache] ${message}`),
                })
                if (localUrl !== undefined) {
                  result = { ...result, mediaRef: { ...result.mediaRef, localUrl } }
                }
                return {
                  status: 'completed',
                  output: JSON.stringify(result),
                }
              }
              if (poll.status === 'failed') {
                return {
                  status: 'failed',
                  detail: `video generation FAILED: ${poll.errorMsg ?? 'unknown reason'} — 生成失败（可能已产生费用）；请用户确认后再决定是否重新生成`,
                }
              }
              await sleep(POLL_INTERVAL_MS, ac.signal)
            }
          })()
          return {
            cancel: (reason?: string) => {
              ac.abort(reason)
            },
            done,
          }
        },
      })
      return { kind: 'background' as const, jobId, taskId: handle.taskId }
    },
  })))

  // No completion followup: the job result (mediaRef + 24h URL) is read by the
  // model through `job_output`. A pushed message would pile up in the
  // session's queued-message tray and force extra model turns.

  // Monotonic deny guard: no provider (`NO_PROVIDER`) is a final deny that
  // later listeners cannot undo. (`MISSING_CREDENTIAL` surfaces at execute
  // time from the provider's own per-operation credential resolve, not here.)
  // The detailed cost estimation/ask lives in `tools/pre-execute` (deployment
  // policy), not here.
  disposers.push(ctx.tools.guard((execution: Readonly<ToolExecution>) => {
    if (execution.name !== name) return undefined
    try {
      const adapter = readActiveAdapter(ctx, 'video')
      if (adapter === undefined) ctx.media.video()
      else ctx.media.video(adapter)
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'NO_PROVIDER') {
        return 'no video provider is configured'
      }
    }
    return undefined
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
