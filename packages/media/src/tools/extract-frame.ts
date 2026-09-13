/**
 * `media_extract_frame` tool: extract still frames from a video (any time or
 * a uniform spread) and land them into the project asset library, so a clip
 * can be continued/referenced later (续拍 / 关键帧参考). Uses ffmpeg/ffprobe
 * from PATH (the DSH host is expected to provide them; see FFMPEG_* env or
 * plain `ffmpeg`). Reuses `media_asset_save`'s reference resolution + index
 * append so extracted frames behave exactly like any other asset.
 *
 * @module @roubaai/media/tools/extract-frame
 */

import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { appendIndex, extractPublicUrl, resolveSource } from './media-asset-save.ts'
import { assetsRoot } from '../asset-root.ts'

export const name = 'media_extract_frame'

/** Allowed asset categories (mirrors media_asset_save). 默认推荐 keyframe——抽帧是从视频派生的参考帧，独立分类最清晰。 */
const CATEGORIES = ['upload', 'character', 'scene', 'prop', 'keyframe', 'storyboard', 'cover'] as const

/** Maximum frames per call (billing/size guard for uniform extraction). */
const MAX_COUNT = 8

const ffmpegBin = (): string => process.env.FFMPEG_BIN ?? 'ffmpeg'
const ffprobeBin = (): string => process.env.FFPROBE_BIN ?? 'ffprobe'

/** 视频参考不支持图片 attachment（attachment 是 ImageAttachmentRef）；返回可给 ffmpeg 的输入或 undefined。 */
function toFfmpegInput(source: { kind: string; url?: string; path?: string }): string | undefined {
  if (source.kind === 'local') return source.path
  if (source.kind === 'url') return source.url
  return undefined
}

/** Probe video duration (seconds) via ffprobe. */
function probeDuration(input: string): number | undefined {
  const res = spawnSync(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input], { timeout: 30000, encoding: 'utf8' })
  if (res.status !== 0) return undefined
  const v = parseFloat((res.stdout ?? '').trim())
  return Number.isFinite(v) ? v : undefined
}

export function registerExtractFrame(ctx: Context): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name,
    description: 'Extract still frames from a video (specific time or uniform spread) and land them into the asset library (same category layout as media_asset_save; recommended category keyframe). Use for 续拍/连续视频 (tail frame of one episode as the next episode opening reference), action keyframes, pose references, scene moments. Requires ffmpeg/ffprobe on PATH (or FFMPEG_BIN/FFPROBE_BIN). Background job: returns a job id.',
    parameters: {
      reference: {
        type: 'string', required: true,
        description: 'The video to extract from. Accepts a Markdown image/video reference, a host URL (/describe-image/raw/... or /api/media.stream/...), a public https URL, a local file path, or a sha256 id.',
      },
      project: { type: 'string', required: true, description: 'Project folder name; frames land under <assetsRoot>/<project>/<category>/.' },
      category: { type: 'string', enum: [...CATEGORIES], required: true, description: 'Asset category. 推荐 keyframe = 从视频抽出的参考帧（续拍/姿态/场景时刻）；按内容归入 character/scene/prop 也可.' },
      name: { type: 'string', required: true, description: 'File base name without extension. May include `/` sub-paths (e.g. 小美/姿态/拔剑). Multi-frame extraction appends _1, _2…' },
      time: { type: 'number', description: 'Extract the frame at this second (e.g. 3.5). Mutually exclusive with count; default extracts the middle frame (50%).' },
      count: { type: 'integer', description: `Extract ${MAX_COUNT} uniformly spread frames (e.g. count=3 → 25%/50%/75%). Mutually exclusive with time.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'background' },
          jobId: { type: 'string', required: true },
          frames: { type: 'array', items: { type: 'string' }, required: true, description: 'Planned frame paths.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Started background frame-extraction job ${value.jobId}; ${value.frames.length} frame(s): ${value.frames.join(', ')}` }],
    },
    async execute(args, exec) {
      const source = resolveSource(args.reference)
      if (source === undefined) {
        throw new Error('media_extract_frame: could not resolve the video reference')
      }
      const input = toFfmpegInput(source)
      if (input === undefined) {
        throw new Error('media_extract_frame: video reference must be a URL, host URL, local path, or sha256 id (attachment references are images)')
      }
      if (args.time !== undefined && args.count !== undefined) {
        throw new Error('media_extract_frame: time and count are mutually exclusive')
      }
      if (args.count !== undefined && (args.count < 1 || args.count > MAX_COUNT)) {
        throw new Error(`media_extract_frame: count must be 1-${MAX_COUNT}`)
      }
      if (/\.\./.test(args.name) || /^[a-zA-Z]:[\\/]/.test(args.name) || args.name.startsWith('/')) {
        throw new Error('media_extract_frame: name must be a relative sub-path without `..` or drive letters')
      }
      const safeName = args.name.replace(/[\\:*?"<>|]/g, '_')
      const count = args.count

      const assets = assetsRoot()
      const projectDir = join(assets, args.project)
      const category = args.category

      // 计划抽帧时刻：time → [t]；count → 均匀 N 点；默认 → 中点。
      const plan = await (async (): Promise<number[]> => {
        if (args.time !== undefined) return [args.time]
        const dur = probeDuration(input)
        const base = dur !== undefined && dur > 0 ? dur : 5
        if (count !== undefined) {
          return Array.from({ length: count }, (_, i) => Math.min(base * (i + 0.5) / count, Math.max(0, base - 0.05)))
        }
        return [base / 2]
      })()

      const frames: string[] = plan.map((_, i) => join(projectDir, category, plan.length === 1 ? `${safeName}.png` : `${safeName}_${i + 1}.png`))

      const jobId = ctx.jobs.start({
        kind: 'media-extract-frame',
        label: `media_extract_frame:${category}/${safeName}`,
        ...exec.agent !== undefined ? { owner: exec.agent } : {},
        run: () => {
          const ac = new AbortController()
          const done = (async (): Promise<{ status: 'completed' | 'failed'; output?: string; detail?: string }> => {
            const tempDir = join(tmpdir(), `dsh-extract-${randomUUID()}`)
            try {
              for (let i = 0; i < plan.length; i++) {
                if (ac.signal.aborted) return { status: 'failed', detail: 'aborted' }
                const t = plan[i]!
                const out = frames[i]!
                await mkdir(dirname(out), { recursive: true })
                // 用 -ss 精确定位 + -frames:v 1；关键帧优先避免大抖动。
                const res = spawnSync(ffmpegBin(), ['-y', '-ss', String(t), '-i', input, '-frames:v', '1', out], { timeout: 90000, encoding: 'utf8' })
                if (ac.signal.aborted) return { status: 'failed', detail: 'aborted' }
                if (res.status !== 0 || res.error !== undefined) {
                  return { status: 'failed', detail: `ffmpeg extract failed at ${t}s: ${(res.stderr ?? '').split('\n').filter(Boolean).slice(-2).join(' ')}` }
                }
                await appendIndex(projectDir, {
                  category, name: plan.length === 1 ? safeName : `${safeName}_${i + 1}`,
                  path: out, ref: args.reference, url: extractPublicUrl(args.reference),
                  ts: Date.now(), mediaType: 'png',
                })
              }
              return { status: 'completed', output: JSON.stringify({ frames }) }
            } catch (error) {
              if (ac.signal.aborted) return { status: 'failed', detail: 'aborted' }
              return { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
            } finally {
              void rm(tempDir, { recursive: true, force: true })
            }
          })()
          return { cancel: (reason?: string) => { ac.abort(reason) }, done }
        },
      })
      return { kind: 'background' as const, jobId, frames }
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Extract frames ${args.name}`,
        kind: 'execute',
        rawInput: `${args.category}/${args.name}`,
      }
    },
  })))

  // No completion followup: the job result (frame paths) is read by the model
  // through `job_output`. A pushed "已提取关键帧" message piles up in the
  // session's queued-message tray and forces extra model turns.

  return () => {
    for (const dispose of disposers) dispose()
  }
}

export default registerExtractFrame
