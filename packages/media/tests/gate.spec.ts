import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkGate, labelIds, manifestIds } from '../src/gate.ts'

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
