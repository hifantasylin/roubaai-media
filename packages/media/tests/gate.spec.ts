import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkGate, labelIds, manifestIds, unitOf } from '../src/gate.ts'

/**
 * A project directory holding a manifest, built fresh per test. These cases are
 * about the manifest half; the canvas is deliberately not part of the fixture —
 * it is a display layer laid only when the user asks for one, and a project
 * without it must still generate.
 */
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
    const reason = decision.allow === false ? decision.reason : ''
    expect(reason).toContain('KF03')
    // The rule is quoted from the document it cites, so the reader can go read
    // it rather than take the gate's word for it.
    expect(reason).toContain('未列入的不生成')
    expect(reason).toContain('参考 05-asset-library.md')
    expect(reason.split('\n')).toHaveLength(1)
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
    // Only the manifest half is asserted. What this proves is the thing it was
    // written for: a declared id is not refused as an undeclared one.
    const reason = decision.allow === false ? decision.reason : ''
    expect(reason).not.toContain('未列入的不生成')
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

/** How old a unit's artifacts are, so "newer" is never a same-millisecond tie. */
const UNIT_MTIME = new Date(Date.now() - 120_000)

/**
 * A project holding one unit's artifacts, with a manifest and a ledger when a
 * test asks for one.
 *
 * No canvas anywhere: it left the gate on 2026-09-18 (it is a display layer the
 * skill lays only when the user asks), so nothing here has to lay one to pass.
 */
async function unitFixture(options: {
  manifest?: string
  prompt?: string | null
  unitFile?: string
  ledger?: unknown
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gate-unit-'))
  const dir = join(root, '演示项目')
  await mkdir(dir, { recursive: true })
  const artifacts: string[] = []
  if (options.manifest !== undefined) await writeFile(join(dir, '演示项目_资产库.md'), options.manifest)
  if (options.prompt !== null) {
    await mkdir(join(dir, 'prompts'), { recursive: true })
    await writeFile(join(dir, 'prompts', 'U01.md'), options.prompt ?? PROMPT)
    artifacts.push(join(dir, 'prompts', 'U01.md'))
  }
  if (options.unitFile !== undefined) {
    await mkdir(join(dir, '分镜', '单元'), { recursive: true })
    await writeFile(join(dir, '分镜', '单元', 'U01.md'), options.unitFile)
    artifacts.push(join(dir, '分镜', '单元', 'U01.md'))
  }
  if (options.ledger !== undefined) {
    await mkdir(join(dir, '.gates'), { recursive: true })
    await writeFile(join(dir, '.gates', 'l0.json'), JSON.stringify(options.ledger))
  }
  // Backdated so "newer" is never a same-millisecond tie.
  for (const artifact of artifacts) await utimes(artifact, UNIT_MTIME, UNIT_MTIME)
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

  it('refuses a prompt that exists but was never stamped, and cites the document', async () => {
    const root = await unitFixture({})
    const decision = await checkGate({ kind: 'video', assetsRoot: root, project: '演示项目', unit: 'U01' })
    expect(decision.allow).toBe(false)
    const reason = decision.allow === false ? decision.reason : ''
    // One line plus a pointer, readable without this conversation: naming the
    // rule that failed and the document that states it. The procedure itself
    // lives in that document, so repeating it here would only rot.
    expect(reason).toContain('还没过 L0 闸门')
    expect(reason).toContain('参考 00-gates.md')
    expect(reason).not.toContain('单子')
    expect(reason.split('\n')).toHaveLength(1)
  })

  it('refuses a prompt edited after it was stamped', async () => {
    const root = await unitFixture({ prompt: `${PROMPT}\n改了一句。\n`, ledger: ledgerFor('prompts/U01.md', PROMPT) })
    const decision = await checkGate({ kind: 'video', assetsRoot: root, project: '演示项目', unit: 'U01' })
    expect(decision.allow).toBe(false)
    const reason = decision.allow === false ? decision.reason : ''
    expect(reason).toContain('没重跑')
    expect(reason).toContain('参考 00-gates.md')
  })

  it('refuses a stamp that recorded an ERROR, naming the failed checks', async () => {
    const root = await unitFixture({ ledger: ledgerFor('prompts/U01.md', PROMPT, ['光影 8 项缺 8 项', '表演 7 项缺 7 项']) })
    const decision = await checkGate({ kind: 'video', assetsRoot: root, project: '演示项目', unit: 'U01' })
    expect(decision.allow).toBe(false)
    const reason = decision.allow === false ? decision.reason : ''
    expect(reason).toContain('2 个 ERROR')
    // Which checks failed, not what they said: enough to know where to look.
    expect(reason).toContain('光影 8 项缺 8 项')
    expect(reason).toContain('表演 7 项缺 7 项')
    expect(reason).toContain('参考 00-gates.md')
  })

  it('names the storyboard file when that is the artifact that is missing a stamp', async () => {
    const root = await unitFixture({ prompt: null, unitFile: '# U01\n' })
    const decision = await checkGate({ kind: 'video', assetsRoot: root, project: '演示项目', unit: 'U01' })
    expect(decision.allow).toBe(false)
    const reason = decision.allow === false ? decision.reason : ''
    expect(reason).toContain('分镜/单元/U01.md')
    expect(reason).toContain('参考 00-gates.md')
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

describe('the canvas is not part of the gate', () => {
  it('admits a unit that passed L0 and was never laid out on the canvas', async () => {
    // The rule that used to live here (2026-09-17 → 2026-09-18) refused this.
    // It was removed because the canvas is a display layer the skill lays only
    // when the user asks for one: "no canvas yet" is a legitimate state of a
    // project that is generating, so it cannot be a reason to refuse a call.
    const root = await unitFixture({ ledger: ledgerFor('prompts/U01.md', PROMPT) })
    const decision = await checkGate({ kind: 'video', assetsRoot: root, project: '演示项目', unit: 'U01' })
    expect(decision.allow).toBe(true)
  })

  it('does not read the blueprint at all, so a stale one changes nothing', async () => {
    const root = await unitFixture({ ledger: ledgerFor('prompts/U01.md', PROMPT) })
    const dir = join(root, '演示项目')
    const blueprint = join(dir, 'canvas-blueprint.json')
    await writeFile(blueprint, '{"nodes":[],"connections":[]}')
    // Older than the prompt it would have been checked against, i.e. the exact
    // shape of the old "比画布新" refusal.
    const old = new Date(Date.now() - 600_000)
    await utimes(blueprint, old, old)
    const decision = await checkGate({ kind: 'video', assetsRoot: root, project: '演示项目', unit: 'U01' })
    expect(decision.allow).toBe(true)
  })

  it('leaves a unit with no artifact alone, the same asymmetry the L0 half uses', async () => {
    const root = await unitFixture({ manifest: MANIFEST })
    const decision = await checkGate({ kind: 'video', assetsRoot: root, project: '演示项目', unit: 'U13' })
    expect(decision.allow).toBe(true)
  })
})

/**
 * A project holding a manifest and whatever asset images a test asks for. No
 * blueprint: images are gated on the manifest and the L0 ledger only.
 */
async function assetFixture(options: {
  manifest?: string
  images?: readonly string[]
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gate-asset-'))
  const dir = join(root, '演示项目')
  await mkdir(dir, { recursive: true })
  if (options.manifest !== undefined) await writeFile(join(dir, '演示项目_资产库.md'), options.manifest)
  const landed = new Date(Date.now() - 120_000)
  for (const rel of options.images ?? []) {
    const path = join(dir, rel)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'not really a png')
    await utimes(path, landed, landed)
  }
  return root
}

describe('images are gated on the manifest, not on the canvas', () => {
  const IMAGE = '01_角色/CH001_主角/02_定稿图/CH001_主角.png'

  it('admits the batch when no canvas was ever laid', async () => {
    const root = await assetFixture({ manifest: MANIFEST })
    const decision = await checkGate({ kind: 'image', assetsRoot: root, project: '演示项目', label: 'CH001_主角' })
    expect(decision.allow).toBe(true)
  })

  it('admits the batch however many images have landed', async () => {
    const root = await assetFixture({
      manifest: MANIFEST,
      images: [IMAGE, '02_场景/SC001_厨房/02_定稿图/SC001_厨房.png', '03_道具/PR001_陶锅/02_定稿图/PR001_陶锅.png'],
    })
    const decision = await checkGate({ kind: 'image', assetsRoot: root, project: '演示项目', label: 'PR001_陶锅' })
    expect(decision.allow).toBe(true)
  })

  it('still refuses an image the manifest never planned', async () => {
    const root = await assetFixture({ manifest: MANIFEST })
    const decision = await checkGate({ kind: 'image', assetsRoot: root, project: '演示项目', label: 'KF03_格3_奶奶出门' })
    expect(decision.allow).toBe(false)
    expect(decision.allow === false && decision.reason).toContain('KF03')
    expect(decision.allow === false && decision.reason).toContain('05-asset-library.md')
  })

  it('leaves a project with no manifest alone, so the style probes at P1 still run', async () => {
    // 门 0 的非对称：立项前没有清单，那几张风格试探是正当的第一站活。
    const root = await assetFixture({ images: ['05_风格参考/ST001_风格四选一.png'] })
    const decision = await checkGate({ kind: 'image', assetsRoot: root, project: '演示项目', label: '风格候选 二' })
    expect(decision.allow).toBe(true)
  })
})
