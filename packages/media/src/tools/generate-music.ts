/**
 * `generate_music` tool: BGM / song generation via a configured music
 * provider (Suno-style: inspiration or custom lyrics mode), run as a
 * `ctx.jobs` background task — music generation takes 1-3 minutes and must
 * not block the foreground `execute`.
 *
 * One generation request yields **2 candidate tasks** (Suno convention). The
 * background loop polls all of them and resolves as soon as the FIRST one
 * completes (BGM workflows need one usable track, not both); the result
 * carries every task's terminal state so the model can see the skipped
 * sibling. The model reads the result through `job_output` — no completion
 * message is pushed into the session (queued-message tray discipline).
 *
 * The result's `audioUrl` is a 24h provider URL: persist it with
 * `media_asset_save` (reference = the URL) to survive expiry.
 *
 * @module @roubaai/media/tools/generate-music
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { MusicGenerateInput, MusicGenerationResult } from '../provider.ts'
import { readActiveAdapter } from '../settings-lookup.ts'
import { appendMediaCost, DEFAULT_PROJECT } from '../cost-ledger.ts'
import { downloadToCache } from '../media-cache.ts'
import { primaryAssetsRoot, workspaceOfAgent } from '../asset-root.ts'

export const name = 'generate_music'

/** Poll interval between provider polls inside the background task. */
const POLL_INTERVAL_MS = 10_000

/**
 * End-to-end polling bound for a music generation. Music typically completes
 * in 1-3 minutes; 10 minutes covers queue spikes. On expiry the job reports
 * a retryable `failed` rather than hanging.
 */
const MUSIC_POLL_TIMEOUT_MS = 600_000

/** A `sleep` helper for the polling loop. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) {
      setTimeout(resolve, ms)
      return
    }
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
 * Validate cross-field constraints the schema DSL cannot express: exactly one
 * of description/lyrics, and the 0-1 slider ranges.
 */
function validateMusicArgs(args: {
  description?: string
  lyrics?: string
  styleWeight?: number
  weirdnessConstraint?: number
}): void {
  if ((args.description === undefined || args.description.trim().length === 0)
    && (args.lyrics === undefined || args.lyrics.trim().length === 0)) {
    throw new Error('generate_music: provide either description (灵感模式) or lyrics (自定义模式)')
  }
  for (const [field, value] of [['styleWeight', args.styleWeight], ['weirdnessConstraint', args.weirdnessConstraint]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`generate_music: ${field} must be a number between 0 and 1`)
    }
  }
}

/**
 * Register the `generate_music` tool. `ctx.jobs.start` is synchronous and
 * returns a `JobId`; `run()` is synchronous and returns `{ cancel, done }`.
 */
export function registerGenerateMusic(ctx: Context): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name,
    description: 'Generate background music / a song (Suno-style). **本次调用会启动 2 个并行后台任务（不是 1 个）**：Suno 每次生成 2 首候选，每个候选一个独立 DSH job——返回值里 **jobs 数组才是完整列表（2 个 jobId）**，顶层 jobId/taskId 只是第 1 个候选的快捷字段。两首独立完成、独立轮询：哪首先完成就先 job_output {wait:true} 读哪首，**不要等另一首**；两首都到手后挑更好的用 media_asset_save 落盘（24h audio URL），另一首无视即可。Two modes: 灵感模式 pass description OR 自定义模式 pass lyrics + tags. **description 必须是完整的一段式公式，缺一项即为劣质提示词**："[情绪形容词] [曲风] instrumental for [场景], featuring [主乐器] and [辅乐器], [BPM] tempo, [动态走向], [X-bar 结构按目标时长换算: ≤10s→4-bar sting / 10-30s→8-16 bar loop / 30-60s→16-24 bar A-B / 60-90s→32-bar A-B-A\u0027 / 更长→48-64 bar 多段], in [调性], evoking [预期感受]." 例: "Warm and tender ambient instrumental for a healing animation, featuring soft piano and gentle strings, 70 BPM, gentle dynamics, 32-bar A-B-A\u0027 structure with peak at bar 20, in F major, evoking peace and comfort." BGM for videos: instrumental=true (no vocals), 结构小节数按成片累计时长换算. COST: points-based per generation. 播放展示：完成的候选在读 job_output 时会自动显示在对话中的工具结果卡（内嵌播放器）——**不要**再把 audioUrl 用 Markdown 贴进回复，也不要贴整段 JSON；封面会作为封面展示。',
    parameters: {
      description: { type: 'string', description: '灵感模式：音乐描述（风格/情绪/场景，如 "轻快的管弦乐，温暖，适合小镇黄昏场景"）。与 lyrics 二选一。' },
      lyrics: { type: 'string', description: '自定义模式：完整歌词。与 description 二选一；用 instrumental 代替无歌词需求。' },
      tags: { type: 'string', description: '自定义模式：音乐风格标签（如 "pop, rock, cinematic"）。' },
      negativeTags: { type: 'string', description: '排除的风格（如 "heavy drums"）。' },
      title: { type: 'string', description: '歌名。' },
      instrumental: { type: 'boolean', description: '纯音乐（无人声）。BGM 场景建议 true；缺省 false（人声歌）。' },
      vocalGender: { type: 'string', enum: ['m', 'f'], description: '人声性别（无人声时忽略）。' },
      styleWeight: { type: 'number', description: '风格参考度 0-1。' },
      weirdnessConstraint: { type: 'number', description: '怪异约束度 0-1。' },
      model: { type: 'string', description: '模型版本覆盖（chirp-bluejay 推荐 / chirp-v4 / chirp-crow 等）；缺省用 provider 默认。' },
      project: { type: 'string', description: '成本记账用：当前项目名（如 奇幻超人），用于媒体成本账归档；不传则归到工作空间。' },
      label: { type: 'string', description: '成本记账用：本资产标识（如 EP01_BGM_轻快）；同一 (project,label) 第二次出现自动记为重试。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'background' },
          jobId: { type: 'string', required: true, description: 'First candidate job id (= jobs[0].jobId).' },
          taskId: { type: 'string', required: true, description: 'First candidate task id.' },
          jobs: {
            type: 'array',
            required: true,
            description: '每候选任务一个独立 job（通常 2 个）——各自独立完成，用 job_output 分别读取，先完成先拿。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                jobId: { type: 'string', required: true },
                taskId: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Started ${value.jobs.length} parallel background music jobs (${value.jobs.map(j => j.jobId).join(', ')}) — one per candidate track; read each via job_output, first finished first`,
      }],
    },
    async execute(args, exec) {
      validateMusicArgs(args)
      // Route through the backend the Settings page activated for music. An
      // unconfigured deployment names none, and keeps whatever single provider
      // its composition registered — the behavior it has always had.
      const adapter = readActiveAdapter(ctx, 'music')
      const provider = adapter === undefined ? ctx.media.music() : ctx.media.music(adapter)
      const input: MusicGenerateInput = {
        ...args.description !== undefined ? { description: args.description } : {},
        ...args.lyrics !== undefined ? { lyrics: args.lyrics } : {},
        ...args.tags !== undefined ? { tags: args.tags } : {},
        ...args.negativeTags !== undefined ? { negativeTags: args.negativeTags } : {},
        ...args.title !== undefined ? { title: args.title } : {},
        ...args.instrumental !== undefined ? { instrumental: args.instrumental } : {},
        ...args.vocalGender !== undefined ? { vocalGender: args.vocalGender } : {},
        ...args.styleWeight !== undefined ? { styleWeight: args.styleWeight } : {},
        ...args.weirdnessConstraint !== undefined ? { weirdnessConstraint: args.weirdnessConstraint } : {},
        ...args.model !== undefined ? { model: args.model } : {},
      }
      // One generation request returns N candidate tasks (Suno: 2). Each task
      // becomes its OWN DSH job — independent polling, independent completion,
      // independent `job_output` reads. The model grabs whichever finishes
      // first and never waits on the slower sibling; both tracks remain
      // retrievable (no wasted points).
      const handles = await provider.submit(input, exec.signal)
      const started = handles.map((handle) => {
        const jobId = ctx.jobs.start({
          kind: 'media-music',
          label: `generate_music:${handle.taskId}`,
          ...exec.agent !== undefined ? { owner: exec.agent } : {},
          run: () => {
            const ac = new AbortController()
            const deadline = Date.now() + MUSIC_POLL_TIMEOUT_MS
            const done = (async (): Promise<JobOutcome> => {
              for (;;) {
                if (ac.signal.aborted) return { status: 'killed' }
                if (Date.now() > deadline) {
                  return { status: 'failed', detail: `music generation timed out after ${MUSIC_POLL_TIMEOUT_MS / 1000}s` }
                }
                let poll
                try {
                  poll = await handle.poll(ac.signal)
                } catch (error) {
                  if (ac.signal.aborted) return { status: 'killed' }
                  return { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
                }
                if (poll.status === 'succeeded') {
                  let track
                  try {
                    track = await provider.fetchTrack(handle.taskId, ac.signal)
                  } catch (error) {
                    if (ac.signal.aborted) return { status: 'killed' }
                    return { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
                  }
                  // Cache the finished track locally BEFORE settling the job
                  // so the track carries a same-origin signed stream URL
                  // (`track.localUrl`): the player streams the local file and
                  // never touches the slow provider CDN. Failure only loses the
                  // fast path — `track.audioUrl` (CDN) stays as the fallback.
                  const localUrl = await downloadToCache({
                    url: track.audioUrl,
                    mediaType: 'audio/mpeg',
                    fallbackExt: 'mp3',
                    log: message => ctx.logger.warn(`[media-cache] ${message}`),
                  })
                  if (localUrl !== undefined) {
                    track = { ...track, localUrl }
                  }
                  const result: MusicGenerationResult = {
                    kind: 'music',
                    mediaType: 'audio/mpeg',
                    track,
                    tracks: [track],
                    tasks: [{ taskId: handle.taskId, status: 'completed' }],
                    providerMeta: { provider: provider.provider, model: args.model ?? provider.defaultModel },
                  }
                  // Automatic cost accounting: mxapi is points-based and never
                  // reports USD — record the occurrence (model + count) with a
                  // zero USD placeholder; the owner converts points themselves.
                  // A ledger write failure must never fail the generation.
                  try {
                    const assets = primaryAssetsRoot(workspaceOfAgent(exec.agent))
                    await appendMediaCost(assets, {
                      ts: Date.now(),
                      tool: 'music',
                      model: args.model ?? provider.defaultModel,
                      project: args.project ?? DEFAULT_PROJECT,
                      ...args.label !== undefined ? { label: args.label } : {},
                      spec: track.durationSeconds !== undefined ? `${Math.round(track.durationSeconds)}s` : 'music',
                      costUsd: 0,
                      source: 'estimated',
                      taskId: handle.taskId,
                    })
                  } catch (costError) {
                    ctx.logger.warn(`media cost ledger append failed: ${String(costError)}`)
                  }
                  return {
                    status: 'completed',
                    output: JSON.stringify(result),
                  }
                }
                if (poll.status === 'failed') {
                  return { status: 'failed', detail: poll.errorMsg ?? 'music generation failed' }
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
        return { jobId, taskId: handle.taskId }
      })
      return {
        kind: 'background' as const,
        jobId: started[0]?.jobId ?? '',
        taskId: started[0]?.taskId ?? '',
        jobs: started,
      }
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: 'Generate music',
        kind: 'execute',
        rawInput: args.title ?? args.description ?? args.tags ?? args.lyrics ?? '',
      }
    },
  })))

  // Monotonic deny guard: no music provider (`NO_PROVIDER`) is a final deny.
  disposers.push(ctx.tools.guard((execution: Readonly<ToolExecution>) => {
    if (execution.name !== name) return undefined
    try {
      const adapter = readActiveAdapter(ctx, 'music')
      if (adapter === undefined) ctx.media.music()
      else ctx.media.music(adapter)
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'NO_PROVIDER') {
        return 'no music provider is configured'
      }
    }
    return undefined
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}

export default registerGenerateMusic
