/**
 * The generation gate: the single place that decides whether a paid generation
 * may start at all.
 *
 * This is the "who may spend money" boundary, not a lint. It runs before the
 * provider is asked to submit anything, so a refusal costs nothing — which is
 * the whole point: the expensive mistakes (generating an asset the project
 * never planned, generating a shot whose prompt was never reviewed) are caught
 * at the first frame rather than after ten of them.
 *
 * ## Why it lives here and not in a skill
 *
 * A skill can only *ask* the model to follow a process. The model may skip it,
 * misread it, or explain it away — and in the project this design came from, it
 * did all three. A rule the model can talk its way past is not a rule. This
 * function cannot be talked past: `submit` is never reached, so nothing is
 * billed.
 *
 * ## What it deliberately does not do
 *
 * It does not review the prompt's quality, judge the framing, or second-guess a
 * creative decision. It checks one thing — whether the work being paid for is
 * work this project planned — and leaves everything inside that boundary to the
 * model and the user.
 *
 * @module @roubaai/media/gate
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The generation kinds the gate guards. */
export type GateKind = 'image' | 'video'

/** One request to spend money, reduced to the facts the gate needs. */
export interface GateRequest {
  /** Which paid tool is being called. */
  readonly kind: GateKind
  /** The project the work belongs to (`project` tool argument). */
  readonly project?: string | undefined
  /** The shot or asset identifier (`label` tool argument). */
  readonly label?: string | undefined
  /** The unit this shot belongs to, when the caller names it outright. */
  readonly unit?: string | undefined
  /** The writable asset root holding `<project>/` directories. */
  readonly assetsRoot: string
}

/** The gate's answer. A refusal always carries a reason the model can act on. */
export type GateDecision =
  | { readonly allow: true; readonly note?: string }
  | { readonly allow: false; readonly reason: string }

/**
 * Asset-id prefixes the project manifests use. `KF` is included on purpose:
 * a per-panel "key frame" is not an asset this pipeline plans, so naming one
 * has to fail the manifest lookup rather than slip through as an unknown word.
 * A generated image may never stand in for a first frame (that is always an
 * extracted tail frame), and this is where that gets enforced.
 *
 * The bounds are lookarounds, not `\b`: ids are routinely written glued to a
 * separator (`KF03_格3`, `ST001_风格锁`), and `_` counts as a word character —
 * so a trailing `\b` silently fails to match exactly the ids this gate exists
 * to catch.
 */
const ASSET_ID = /(?<![A-Za-z0-9])(?:CH|SC|PR|ST|CL|NP|KF|FF)\d{2,3}(?!\d)/giu

/** The manifest's own id shapes, which is what an asset list actually holds. */
const MANIFEST_ID = /(?<![A-Za-z0-9])(?:CH|SC|PR|ST|CL|NP)\d{3}(?!\d)/giu

/** How the project's asset manifest is named, wherever it sits. */
const MANIFEST_SUFFIX = '资产库.md'

/**
 * Every asset id the project's manifest declares.
 *
 * The manifest writes ids two ways — a table row (`| CH001 | 大牙 | …`) and a
 * heading (`### ST001_…`) — so the whole file is scanned for ids rather than
 * one section parsed. A manifest that gains another section keeps working.
 * @param text - the manifest file's contents.
 * @returns the declared ids, upper-cased and deduplicated.
 */
export function manifestIds(text: string): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const match of text.matchAll(MANIFEST_ID)) ids.add(match[0].toUpperCase())
  return ids
}

/**
 * The asset ids a `label` names. A label is free text (`KF03_格3_奶奶出门`,
 * `EP01_镜02_镇民躲藏`), so this is a scan, not a parse.
 * @param label - the tool call's `label` argument.
 * @returns the named ids, upper-cased and deduplicated.
 */
export function labelIds(label: string): readonly string[] {
  const ids = new Set<string>()
  for (const match of label.matchAll(ASSET_ID)) ids.add(match[0].toUpperCase())
  return [...ids]
}

/**
 * Find the project's asset manifest.
 * @param projectDir - the project's directory under the asset root.
 * @returns the manifest's absolute path, or undefined when the project has none.
 */
async function findManifest(projectDir: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(projectDir)
  } catch {
    return undefined
  }
  const named = entries.filter(entry => entry.endsWith(MANIFEST_SUFFIX)).sort()
  return named.length === 0 ? undefined : join(projectDir, named[0]!)
}

/** Where the L0 gate writes its ledger, relative to the project directory. */
const STAMP_FILE = '.gates/l0.json'

/**
 * Where a unit's two artifacts live, relative to the project directory. This
 * mirrors the layout the skill's text-asset single source declares, and is a
 * short explicit list rather than a walk of the project: the gate reads only
 * what it is looking for.
 */
const UNIT_DIRS = ['prompts', '分镜/单元'] as const

/** One recorded L0 result, bound to the hash of the file it ran against. */
interface Stamp {
  readonly sha256: string
  readonly errors: readonly string[]
  readonly tool: string
}

/**
 * The unit a call names: an explicit argument wins, else the label's id.
 *
 * The bounds are lookarounds, not `\b`: a label routinely glues the id to a
 * separator (`U09_厨房空镜`), and `_` is a word character — so a trailing `\b`
 * silently fails to match exactly the labels this is here to read. The same
 * mistake already cost the asset-id scan once.
 */
export function unitOf(request: GateRequest): string | undefined {
  const explicit = request.unit?.trim()
  if (explicit !== undefined && explicit !== '') return explicit.toUpperCase()
  return /(?<![A-Za-z0-9])U\d{2,3}(?!\d)/iu.exec(request.label ?? '')?.[0].toUpperCase()
}

/** The content hash the skill scripts record, computed from the same text. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The L0 ledger's stamps, keyed by project-relative POSIX path. */
async function readStamps(projectDir: string): Promise<Record<string, Stamp>> {
  try {
    const parsed = JSON.parse(await readFile(join(projectDir, STAMP_FILE), 'utf8')) as { stamps?: Record<string, Stamp> }
    return parsed.stamps ?? {}
  } catch {
    return {} // 还没跑过 --stamp，或台账被改坏：当作一条都没有
  }
}

/** Every artifact of one unit that exists on disk, project-relative POSIX. */
async function unitFiles(projectDir: string, unit: string): Promise<readonly string[]> {
  const found: string[] = []
  const prefix = unit.toLowerCase()
  for (const dir of UNIT_DIRS) {
    let entries: string[]
    try {
      entries = await readdir(join(projectDir, dir))
    } catch {
      continue // 这个项目没有这一类产物
    }
    for (const entry of entries.filter(name => name.toLowerCase().startsWith(prefix) && name.endsWith('.md')).sort()) {
      found.push(`${dir}/${entry}`)
    }
  }
  return found
}

/** Which L0 script covers a project-relative artifact. */
function scriptFor(rel: string): 'check-prompt.mjs' | 'check-unit.mjs' {
  return rel.startsWith('prompts/') ? 'check-prompt.mjs' : 'check-unit.mjs'
}

/**
 * The exact command that would satisfy this refusal.
 *
 * A refusal is worth nothing if the way out is not obvious, and this gate is
 * not here to be a wall — it is here to put the model back on the process it
 * was supposed to be following. Handing over the literal command makes the
 * correct next step cheaper than any way around it, which is the only kind of
 * pressure this design relies on.
 *
 * The path is resolved from `$DSH_HOME` rather than written out: where a skill
 * lives differs per machine.
 * @param rel - the project-relative artifact that needs a stamp.
 * @returns a copy-pasteable command line.
 */
function stampCommand(rel: string): string {
  const script = scriptFor(rel)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const tool = join(home, 'skills', 'roubaai-video-skill', 'references', 'tools', script)
  const path = existsSync(tool) ? `"${tool}"` : `<roubaai-video-skill>/references/tools/${script}`
  return `node ${path} "${rel}" --stamp`
}

/**
 * The L0 half of the gate: a shot may only be paid for once the prompt and the
 * storyboard unit behind it passed the mechanical gate **in the version that is
 * on disk right now**.
 *
 * Only files that exist are checked, and a unit with no file under either
 * directory is not refused — a project that does not keep units this way, or a
 * unit not written yet, has nothing to review, and refusing those would block
 * the start of every project. What is refused is the case this ledger exists
 * for: the file is there, and no current clean stamp covers it.
 *
 * The ledger is an ordinary file, so a model could in principle write one
 * instead of running the check. It has no reason to: forging means computing
 * the file's hash and knowing this schema, where complying is one command — and
 * every refusal prints that command. Guarding against forgery would cost a
 * cross-repository coupling and defend against a motive nothing here creates;
 * the failures this is built for are an invented route and a skipped step, not
 * a lie about work done. So the effort goes into making the way back obvious
 * instead.
 * @param projectDir - the project directory under the asset root.
 * @param unit - the unit id to look up.
 * @returns a refusal, or undefined when there is nothing to refuse.
 */
async function checkUnitStamps(projectDir: string, unit: string): Promise<GateDecision | undefined> {
  const files = await unitFiles(projectDir, unit)
  if (files.length === 0) return undefined
  const stamps = await readStamps(projectDir)

  for (const rel of files) {
    const stamp = stamps[rel]
    if (stamp === undefined) {
      return {
        allow: false,
        reason:
          `generate_video 被拒：${rel} 这一版还没跑过 L0 闸门。\n`
          + `\n`
          + `L0 是免费的机械体检（字数 / 光影 8 项 / 表演 7 项 / 台词 / 切片连续性，见 00-gates.md）。\n`
          + `花钱生成之前必须先过它——没有它的结果，闸门无法确认这一版是合格的。\n`
          + `\n`
          + `跑这一条，它会打印 ERROR 清单并记下这次的结果：\n`
          + `  ${stampCommand(rel)}\n`
          + `\n`
          + `有 ERROR 就改到 0，然后重新提交这次 generate_video。`,
      }
    }
    const current = sha256(await readFile(join(projectDir, rel), 'utf8'))
    if (current !== stamp.sha256) {
      return {
        allow: false,
        reason:
          `generate_video 被拒：${rel} 在跑过 L0 之后又被改动过。\n`
          + `\n`
          + `上次 L0 的结果对应的是改动前的内容，已经不适用——现在这一版没有体检过。\n`
          + `\n`
          + `重跑这一条：\n`
          + `  ${stampCommand(rel)}\n`
          + `\n`
          + `确认 0 ERROR 后，重新提交这次 generate_video。`,
      }
    }
    if (stamp.errors.length > 0) {
      const shown = stamp.errors.slice(0, 5).map(e => `  - ${e}`).join('\n')
      const more = stamp.errors.length > 5 ? `\n  …还有 ${stamp.errors.length - 5} 条` : ''
      return {
        allow: false,
        reason:
          `generate_video 被拒：${rel} 的 L0 结果里有 ${stamp.errors.length} 个 ERROR，花钱之前必须清零：\n`
          + `\n`
          + `${shown}${more}\n`
          + `\n`
          + `改完重跑这一条（会重新体检并更新结果）：\n`
          + `  ${stampCommand(rel)}\n`
          + `\n`
          + `然后重新提交这次 generate_video。`,
      }
    }
  }
  return undefined
}

/**
 * Decide whether one paid generation may start.
 *
 * The gate only refuses when it has something to check against: a project and
 * an asset manifest that both exist, and a `label` naming an id the manifest
 * does not declare. Everything else is allowed and *marked*.
 *
 * That asymmetry is deliberate. Before the asset stage there is no manifest —
 * a style probe at P1 is legitimate work, and refusing it because the project
 * has not planned assets yet would block the start of every project. Refusing
 * on "I cannot tell" would also make the cheapest way past the gate to hand it
 * nothing to read. Marking instead keeps the decision visible without
 * pretending the gate knows something it does not.
 *
 * The refusal that matters is the one it can actually make: the project HAS a
 * plan, and this generation is not in it.
 * @param request - the facts the gate needs about one paid call.
 * @returns whether the call may proceed, and why not when it may not.
 */
export async function checkGate(request: GateRequest): Promise<GateDecision> {
  const kind = `generate_${request.kind}`
  const project = request.project?.trim() ?? ''
  if (project === '') {
    return { allow: true, note: `${kind}: 没带 project，没有清单可核对 —— 放行但标记` }
  }
  const projectDir = join(request.assetsRoot, project)
  const notes: string[] = []

  // ① 清单：这一次生成在项目计划里吗
  const manifestPath = await findManifest(projectDir)
  if (manifestPath === undefined) {
    notes.push('项目还没有资产清单')
  } else {
    const ids = manifestIds(await readFile(manifestPath, 'utf8'))
    const named = labelIds(request.label ?? '')
    const unknown = named.filter(id => !ids.has(id))
    if (unknown.length > 0) {
      // A key-frame id is not a random miss — it is the one shape that has a
      // right answer instead of a route, so say it rather than let the model
      // try to justify adding it.
      const asFirstFrame = unknown.some(id => id.startsWith('KF') || id.startsWith('FF'))
      return {
        allow: false,
        reason:
          `${kind} 被拒：资产清单里没有「${unknown.join('、')}」这一项。\n`
          + `\n`
          + `项目「${project}」的资产清单共 ${ids.size} 项，都与它不匹配。清单外的图不生成——\n`
          + `它不在这个项目的计划里。\n`
          + `\n`
          + (asFirstFrame
            ? `· 如果它是首帧：首帧不用生成。从上一镜的成片抽尾帧即可（media_extract_frame，免费，\n`
              + `  而且天然接得上——生成的首帧跟上一镜尾帧不可能一致，必然跳变）。\n`
            : '')
          + `· 如果确实需要这个资产：从上游加起——先改讲戏本里的资产清单、重新出清单，再生成。\n`
          + `  不能只在这里生成一张清单上没有的图。`,
      }
    }
    if (named.length === 0) notes.push('label 未标明资产编号')
  }

  // ② 单子：这一版的分镜与提示词过没过 L0。只对花钱的镜头生成查。
  if (request.kind === 'video') {
    const unit = unitOf(request)
    if (unit === undefined) {
      notes.push('没标明单元号（label 里没有 U01 这类编号），无法核对 L0 单子')
    } else {
      const refusal = await checkUnitStamps(projectDir, unit)
      if (refusal !== undefined) return refusal
    }
  }

  return notes.length === 0
    ? { allow: true }
    : { allow: true, note: `${kind}: ${notes.join('；')} —— 放行但标记` }
}
