import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerMediaAssetSave } from '../src/tools/media-asset-save.ts'
import { createTempAssetsRoot } from './temp-assets.ts'

const testToolSignal = new AbortController().signal

// The asset root is process-wide now, so this spec claims it and lands there.
const assets = createTempAssetsRoot('roubaai-asset-save-')
let assetsDir = ''

beforeEach(() => { assetsDir = assets.install() })
afterEach(async () => { await assets.restore() })

/** Minimal jobs registry (mirrors tools.spec.ts). */
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
  registerMediaAssetSave(ctx)
  return { ctx, jobs }
}

/** 临时工作区 + 一张假 png 源文件。 */
function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'asset-test-'))
  const src = join(ws, 'src.png')
  writeFileSync(src, Buffer.from('fake-png-bytes'))
  return { ws, src }
}

/** 一个带 cwd 的伪 agent。 */
const agentOf = (cwd: string) => ({ session: { header: { cwd } } }) as never

describe('media_asset_save tool', () => {
  it('exposes category enum including 封面', async () => {
    const { ctx } = await boot()
    const schema = ctx.tools.schemas().find(s => s.name === 'media_asset_save')
    expect(schema).toBeDefined()
    const cat = (schema!.parameters as { properties: Record<string, unknown> }).properties.category as { enum?: string[] }
    expect(cat.enum).toContain('cover')
    expect(cat.enum).toContain('character')
    expect(cat.enum).toContain('prop')
    expect(cat.enum).toContain('keyframe')
  })

  it('saves into a nested sub-path under the category', async () => {
    const { ctx, jobs } = await boot()
    const { ws, src } = makeWorkspace()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('asset-nested'),
      name: 'media_asset_save',
      arguments: { reference: src, project: '测试项目', category: 'character', dir: 'character', name: '小美/服装/礼服' },
      agent: agentOf(ws),
    } as never)
    expect(result.isError).toBe(false)
    const value = result.value as { target?: string }
    expect(value.target).toContain('测试项目\\character\\小美\\服装\\礼服.png')

    // 等后台 job 完成，验证文件与索引落盘
    await jobs.hooks[0]!.done
    const target = value.target!
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target).toString()).toBe('fake-png-bytes')
    const indexPath = join(assetsDir, '测试项目', 'assets-index.md')
    expect(existsSync(indexPath)).toBe(true)
    expect(readFileSync(indexPath, 'utf8')).toContain('小美/服装/礼服')
  })

  it('rejects path traversal and absolute names', async () => {
    const { ctx } = await boot()
    const { ws, src } = makeWorkspace()
    void ws
    for (const bad of ['../逃离', 'C:/abs', '/abs']) {
      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId(`asset-bad-${bad.length}`),
        name: 'media_asset_save',
        arguments: { reference: src, project: '测试项目', category: 'character', dir: 'character', name: bad },
        agent: agentOf(ws),
      } as never)
      expect(result.isError).toBe(true)
      expect(result.error?.message).toMatch(/relative sub-path/)
    }
  })

  it('requires dir and rejects traversal in dir', async () => {
    const { ctx } = await boot()
    const { ws, src } = makeWorkspace()
    void ws
    // 缺 dir → 报错
    const missing = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('asset-dir-missing'),
      name: 'media_asset_save',
      arguments: { reference: src, project: '测试项目', category: 'character', name: 'ok' },
      agent: agentOf(ws),
    } as never)
    expect(missing.isError).toBe(true)
    expect(missing.error?.message).toMatch(/missing required property "dir"/)
    // dir 穿越 → 报错
    for (const bad of ['../逃离', 'C:/abs', '/abs']) {
      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId(`asset-dir-bad2-${bad.length}`),
        name: 'media_asset_save',
        arguments: { reference: src, project: '测试项目', category: 'character', dir: bad, name: 'ok' },
        agent: agentOf(ws),
      } as never)
      expect(result.isError).toBe(true)
      expect(result.error?.message).toMatch(/relative sub-path/)
    }
  })

  it('accepts cover category (fixes stage-8 cover landing)', async () => {
    const { ctx, jobs } = await boot()
    const { ws, src } = makeWorkspace()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('asset-cover'),
      name: 'media_asset_save',
      arguments: { reference: src, project: '测试项目', category: 'cover', dir: 'cover', name: 'EP01_主海报_3x4' },
      agent: agentOf(ws),
    } as never)
    expect(result.isError).toBe(false)
    await jobs.hooks[0]!.done
    const target = (result.value as { target?: string }).target!
    expect(existsSync(target)).toBe(true)
    expect(target).toContain('cover\\EP01_主海报_3x4.png')
  })

  it('dir 参数覆盖 category 作为落盘目录（LLM 自定义结构）', async () => {
    const { ctx, jobs } = await boot()
    const { ws, src } = makeWorkspace()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('asset-dir'),
      name: 'media_asset_save',
      arguments: { reference: src, project: '测试项目', category: 'character', dir: '01_角色/CH001_花十/02_定稿图', name: 'CH001_花十_本体' },
      agent: agentOf(ws),
    } as never)
    expect(result.isError).toBe(false)
    const value = result.value as { target?: string }
    expect(value.target).toContain('测试项目\\01_角色\\CH001_花十\\02_定稿图\\CH001_花十_本体.png')

    await jobs.hooks[0]!.done
    expect(existsSync(value.target!)).toBe(true)
    // assets-index 仍记录 category 语义标签
    const indexPath = join(assetsDir, '测试项目', 'assets-index.md')
    expect(readFileSync(indexPath, 'utf8')).toContain('| character |')
  })

  it('dir 拒绝路径穿越与绝对路径', async () => {
    const { ctx } = await boot()
    const { ws, src } = makeWorkspace()
    void ws
    for (const bad of ['../逃离', 'C:/abs', '/abs']) {
      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId(`asset-dir-bad-${bad.length}`),
        name: 'media_asset_save',
        arguments: { reference: src, project: '测试项目', category: 'character', dir: bad, name: 'ok' },
        agent: agentOf(ws),
      } as never)
      expect(result.isError).toBe(true)
      expect(result.error?.message).toMatch(/relative sub-path/)
    }
  })
})
