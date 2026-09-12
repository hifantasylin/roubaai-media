import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { registerExtractFrame } from '../src/tools/extract-frame.ts'

const testToolSignal = new AbortController().signal

/** 探测 ffmpeg/ffprobe（PATH 或 WinGet 安装位），注入 FFMPEG_BIN/FFPROBE_BIN 供工具复用。 */
const ffprobeBin = (): string | undefined => {
  const candidates = [process.env.FFPROBE_BIN, 'C:/Users/Administrator/AppData/Local/Microsoft/WinGet/Links/ffprobe.exe', 'ffprobe']
  for (const c of candidates) {
    if (c === undefined) continue
    if (spawnSync(c, ['-version'], { timeout: 5000, encoding: 'utf8' }).status === 0) return c
  }
  return undefined
}
const ffmpegBin = (): string | undefined => {
  const candidates = [process.env.FFMPEG_BIN, 'C:/Users/Administrator/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe', 'ffmpeg']
  for (const c of candidates) {
    if (c === undefined) continue
    if (spawnSync(c, ['-version'], { timeout: 5000, encoding: 'utf8' }).status === 0) return c
  }
  return undefined
}
const ffmpeg = ffmpegBin()
const ffprobe = ffprobeBin()
if (ffmpeg !== undefined) process.env.FFMPEG_BIN = ffmpeg
if (ffprobe !== undefined) process.env.FFPROBE_BIN = ffprobe

class StubJobs {
  started: Array<{ kind: string; label: string }> = []
  hooks: Array<{ cancel: (reason?: string) => void; done: Promise<unknown> }> = []
  start(spec: { kind: string; label: string; run: () => { cancel: (reason?: string) => void; done: Promise<unknown> } }): string {
    this.started.push({ kind: spec.kind, label: spec.label })
    this.hooks.push(spec.run())
    return 'job-1'
  }
  onJobDone(): () => void { return () => {} }
  reportProgress(): void {}
  read(): { text: string } { return { text: '' } }
}

async function boot() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const jobs = new StubJobs()
  ctx.provide('jobs', jobs)
  registerExtractFrame(ctx)
  return { ctx, jobs }
}

const agentOf = (cwd: string) => ({ session: { header: { cwd } } }) as never

/** ffmpeg 可用性（缺少时跳过整个 describe）。 */
function hasFfmpeg(): boolean {
  return ffmpeg !== undefined
}

/** 用 ffmpeg 生成 2s 测试视频。 */
function makeTestVideo(dir: string): string | undefined {
  const out = join(dir, 'test.mp4')
  const r = spawnSync(ffmpeg!, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=10', '-pix_fmt', 'yuv420p', out], { timeout: 30000, encoding: 'utf8' })
  if (r.status !== 0) return undefined
  return out
}

describe.skipIf(!hasFfmpeg())('media_extract_frame tool', () => {
  it('exposes category enum and validates time/count mutual exclusion', async () => {
    const { ctx } = await boot()
    const schema = ctx.tools.schemas().find(s => s.name === 'media_extract_frame')
    expect(schema).toBeDefined()
    const properties = (schema!.parameters as { properties: Record<string, unknown> }).properties
    const cat = properties.category as { enum?: string[] }
    expect(cat.enum).toContain('character')
    expect(cat.enum).toContain('prop')
    expect(cat.enum).toContain('keyframe')
    expect(cat.enum).toContain('cover')
    const bad = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('frame-mutex'),
      name: 'media_extract_frame',
      arguments: { reference: 'https://x/v.mp4', project: 'p', category: 'storyboard', name: 'f', time: 1, count: 3 },
      agent: agentOf(mkdtempSync(join(tmpdir(), 'frame-test-'))),
    } as never)
    expect(bad.isError).toBe(true)
    expect(bad.error?.message).toMatch(/mutually exclusive/)
  })

  it('extracts a frame at a given time and lands it as an asset', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'frame-test-'))
    const video = makeTestVideo(ws)
    if (video === undefined) throw new Error('ffmpeg could not create test video')
    const { ctx, jobs } = await boot()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('frame-time'),
      name: 'media_extract_frame',
      arguments: { reference: video, project: '测试项目', category: 'character', name: '小美/姿态/拔剑', time: 1 },
      agent: agentOf(ws),
    } as never)
    expect(result.isError).toBe(false)
    await jobs.hooks[0]!.done
    const frames = (result.value as { frames?: string[] }).frames ?? []
    expect(frames).toHaveLength(1)
    const f = frames[0]!
    expect(f).toContain('character\\小美\\姿态\\拔剑.png')
    expect(existsSync(f)).toBe(true)
    // 落盘的是有效 png（PNG 魔数）
    const head = readFileSync(f).subarray(0, 4).toString('hex')
    expect(head).toBe('89504e47')
    const indexPath = join(ws, '.assets', '测试项目', 'assets-index.md')
    expect(readFileSync(indexPath, 'utf8')).toContain('小美/姿态/拔剑')
  })

  it('extracts a uniform spread with count naming and rejects traversal', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'frame-test-'))
    const video = makeTestVideo(ws)
    if (video === undefined) throw new Error('ffmpeg could not create test video')
    const { ctx, jobs } = await boot()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('frame-count'),
      name: 'media_extract_frame',
      arguments: { reference: video, project: '测试项目', category: 'keyframe', name: 'EP01_尾帧', count: 3 },
      agent: agentOf(ws),
    } as never)
    expect(result.isError).toBe(false)
    await jobs.hooks[0]!.done
    const frames = (result.value as { frames?: string[] }).frames ?? []
    expect(frames).toHaveLength(3)
    expect(frames.every(f => existsSync(f))).toBe(true)
    expect(frames.some(f => f.endsWith('EP01_尾帧_1.png'))).toBe(true)
    expect(frames.some(f => f.endsWith('EP01_尾帧_3.png'))).toBe(true)

    const bad = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('frame-trav'),
      name: 'media_extract_frame',
      arguments: { reference: video, project: '测试项目', category: 'storyboard', name: '../逃逸', time: 1 },
      agent: agentOf(ws),
    } as never)
    expect(bad.isError).toBe(true)
    expect(bad.error?.message).toMatch(/relative sub-path/)
  })
})
