import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkGate, labelIds, manifestIds, unitOf } from '../src/gate.ts'

/** A project directory holding a manifest, built fresh per test. */
async function fixtureProject(manifest: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gate-'))
  const dir = join(root, '演示项目')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '演示项目_资产库.md'), manifest)
  return root
}

const MANIFEST = [
  '# 演示项目 资产库',
  '### ST001_风格锁',
  '| CH001 | 主角 | 主角 | 围裙 | 无 | 定稿 | `01_角色/CH001` |',
  '| SC001 | 厨房 | 全片 | 木桌 | CL001 | 定稿 | `02_场景/SC001` |',
  '| PR001 | 陶锅 | 信物 | 棕花纹 | SC001 | 定稿 | `03_道具/PR001` |',
].join('\n')

describe('manifestIds', () => {
  it('reads ids from both a heading and a table row', () => {
    const ids = manifestIds(MANIFEST)
    // CL001 is counted because the SC001 row references it. Scanning the whole
    // manifest rather than one section is the deliberate trade: a manifest that
    // grows another section keeps working, at the cost of counting a mention as
    // a declaration.
    expect([...ids].sort()).toEqual(['CH001', 'CL001', 'PR001', 'SC001', 'ST001'])
  })

  it('does not treat a key-frame id as a declared asset', () => {
    expect(manifestIds('| KF03 | 格3 |').size).toBe(0)
  })
})

describe('labelIds', () => {
  it('pulls the asset id out of a shot label', () => {
    expect(labelIds('KF03_格3_奶奶出门')).toEqual(['KF03'])
  })

  it('finds no id in a pure description', () => {
    expect(labelIds('封面主图')).toEqual([])
  })

  it('normalises case and de-duplicates', () => {
    expect(labelIds('ch001 与 CH001')).toEqual(['CH001'])
  })
})

describe('checkGate', () => {
  it('allows a call with no project name, and marks it', async () => {
    const decision = await checkGate({ kind: 'image', assetsRoot: '/nowhere', project: '' })
    expect(decision.allow).toBe(true)
    expect(decision.allow === true && decision.note).toContain('没带 project')
  })

  it('allows a project that has no manifest yet, and marks it', async () => {
    const root = await fixtureProject(MANIFEST)
    const decision = await checkGate({ kind: 'image', assetsRoot: root, project: '还没立项的项目' })
    expect(decision.allow).toBe(true)
    expect(decision.allow === true && decision.note).toContain('还没有资产清单')
  })

  it('allows a label that names a declared asset', async () => {
    const root = await fixtureProject(MANIFEST)
    const decision = await checkGate({
      kind: 'image', assetsRoot: root, project: '演示项目', label: 'SC001_厨房母版',
    })
    expect(decision.allow).toBe(true)
  })

  it('refuses the key-frame case: an id the manifest never declared', async () => {
    const root = await fixtureProject(MANIFEST)
    const decision = await checkGate({
      kind: 'image', assetsRoot: root, project: '演示项目', label: 'KF03_格3_奶奶出门',
    })
    expect(decision.allow).toBe(false)
    expect(decision.allow === false && decision.reason).toContain('KF03')
    expect(decision.allow === false && decision.reason).toContain('清单共 5 项')
  })

  it('reports every unknown id at once', async () => {
    const root = await fixtureProject(MANIFEST)
    const decision = await checkGate({
      kind: 'image', assetsRoot: root, project: '演示项目', label: 'KF03 与 FF01',
    })
    expect(decision.allow === false && decision.reason).toContain('KF03、FF01')
  })

  it('allows a label with no asset id, and says so', async () => {
    const root = await fixtureProject(MANIFEST)
    const decision = await checkGate({
      kind: 'image', assetsRoot: root, project: '演示项目', label: '封面主图',
    })
    expect(decision.allow).toBe(true)
    expect(decision.allow === true && decision.note).toContain('未标明资产编号')
  })
})

/**
 * The same judgement against a manifest a real project actually produced, so the
 * parser is not only proven against a fixture written to match it. Skipped when
 * the project is not on this machine: the path belongs to a workspace, not to
 * the repository.
 */
const REAL_ROOT = 'F:\\Workspace\\DeepSeekSpace\\.assets'
const REAL_PROJECT = '红果子'
const realManifest = join(REAL_ROOT, REAL_PROJECT, `${REAL_PROJECT}_资产库.md`)
const hasReal = existsSync(realManifest)

describe.skipIf(!hasReal)('checkGate against a real project manifest', () => {
  it('declares the assets the manifest lists', async () => {
    const ids = manifestIds(await readFile(realManifest, 'utf8'))
    expect(ids.has('SC001')).toBe(true)
    expect(ids.has('CH001')).toBe(true)
    expect(ids.has('PR001')).toBe(true)
  })

  it('admits a shot that names a declared asset', async () => {
    const decision = await checkGate({
      kind: 'image', assetsRoot: REAL_ROOT, project: REAL_PROJECT, label: 'SC001_高崖草原_母版',
    })
    expect(decision.allow).toBe(true)
  })

  it('refuses a key frame the project never planned', async () => {
    const decision = await checkGate({
      kind: 'image', assetsRoot: REAL_ROOT, project: REAL_PROJECT, label: 'KF03_格3_奶奶出门',
    })
    expect(decision.allow).toBe(false)
    expect(decision.allow === false && decision.reason).toContain('KF03')
  })
})

const PROMPT = '# U01\n\n```\n一个最小提示词\n```\n'

/** A project holding one unit's artifacts, with a ledger when asked for one. */
async function unitFixture(options: { prompt?: string | null; unitFile?: string; ledger?: unknown }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gate-unit-'))
  const dir = join(root, '演示项目')
  if (options.prompt !== null) {
    await mkdir(join(dir, 'prompts'), { recursive: true })
    await writeFile(join(dir, 'prompts', 'U01.md'), options.prompt ?? PROMPT)
  }
  if (options.unitFile !== undefined) {
    await mkdir(join(dir, '分镜', '单元'), { recursive: true })
    await writeFile(join(dir, '分镜', '单元', 'U01.md'), options.unitFile)
  }
  if (options.ledger !== undefined) {
    await mkdir(join(dir, '.gates'), { recursive: true })
    await writeFile(join(dir, '.gates', 'l0.json'), JSON.stringify(options.ledger))
  }
  return root
}

/** A ledger recording one clean stamp for `rel` over `text`. */
function ledgerFor(rel: string, text: string, errors: readonly string[] = []): unknown {
  return {
    version: 1,
    stamps: {
      [rel]: { sha256: createHash('sha256').update(text, 'utf8').digest('hex'), errors, warns: [], chars: 1, tool: 'check-prompt.mjs', ts: 1 },
    },
  }
}

describe('the L0 stamp half of the gate', () => {
  it('reads the unit from the label when no argument names one', async () => {
    expect(unitOf({ kind: 'video', assetsRoot: '/x', label: 'U09_厨房空镜' })).toBe('U09')
    expect(unitOf({ kind: 'video', assetsRoot: '/x', label: '开场空镜' })).toBeUndefined()
  })

  it('lets an explicit unit argument win over the label', () => {
    expect(unitOf({ kind: 'video', assetsRoot: '/x', label: 'U09_x', unit: 'u13' })).toBe('U13')
  })

  it('refuses a prompt that exists but was never stamped, and hands over the command', async () => {
    const root = await unitFixture({})
    const decision = await checkGate({ kind: 'video', assetsRoot: root, project: '演示项目', unit: 'U01' })
    expect(decision.allow).toBe(false)
    expect(decision.allow === false && decision.reason).toContain('没有 L0 单子')
    // A refusal is a route: the way out has to be in the message, not just the
    // fact that something is missing.
    expect(decision.allow === false && decision.reason).toContain('check-prompt.mjs')
    expect(decision.allow === false && decision.reason).toContain('--stamp')
  })

  it('refuses a prompt edited after it was stamped', async () => {
    const root = await unitFixture({ prompt: `${PROMPT}\n改了一句。\n`, ledger: ledgerFor('prompts/U01.md', PROMPT) })
    const decision = await checkGate({ kind: 'video', assetsRoot: root, project: '演示项目', unit: 'U01' })
    expect(decision.allow).toBe(false)
    expect(decision.allow === false && decision.reason).toContain('改过之后没有重跑 L0')
  })

  it('refuses a stamp that recorded an ERROR', async () => {
    const root = await unitFixture({ ledger: ledgerFor('prompts/U01.md', PROMPT, ['光影 8 项缺 8 项']) })
    const decision = await checkGate({ kind: 'video', assetsRoot: root, project: '演示项目', unit: 'U01' })
    expect(decision.allow).toBe(false)
    expect(decision.allow === false && decision.reason).toContain('1 个 ERROR')
    expect(decision.allow === false && decision.reason).toContain('--stamp')
  })

  it('names the storyboard checker when the missing stamp is on the unit file', async () => {
    const root = await unitFixture({ prompt: null, unitFile: '# U01\n' })
    const decision = await checkGate({ kind: 'video', assetsRoot: root, project: '演示项目', unit: 'U01' })
    expect(decision.allow).toBe(false)
    expect(decision.allow === false && decision.reason).toContain('分镜/单元/U01.md')
    expect(decision.allow === false && decision.reason).toContain('check-unit.mjs')
  })

  it('admits a clean, current stamp', async () => {
    const root = await unitFixture({ ledger: ledgerFor('prompts/U01.md', PROMPT) })
    const decision = await checkGate({ kind: 'video', assetsRoot: root, project: '演示项目', unit: 'U01' })
    expect(decision.allow).toBe(true)
  })

  it('leaves a unit with no file alone, so a project without this layout still generates', async () => {
    const root = await unitFixture({})
    const decision = await checkGate({ kind: 'video', assetsRoot: root, project: '演示项目', unit: 'U13' })
    expect(decision.allow).toBe(true)
  })

  it('does not look for stamps when the call is not a video', async () => {
    const root = await unitFixture({})
    const decision = await checkGate({ kind: 'image', assetsRoot: root, project: '演示项目', label: 'U01_x' })
    expect(decision.allow).toBe(true)
  })
})
