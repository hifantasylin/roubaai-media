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
 * creative decision. It asks whether the work being paid for is work this
 * project planned, reviewed, and laid out for the user to look at — three facts
 * about the project's own files — and leaves everything inside that boundary to
 * the model and the user.
 *
 * Of those three, "reviewed" is a process fact rather than a property of the
 * artifact: it exists on disk only because a reviewer wrote it down. So the gate
 * reads two ledgers — `.gates/l0.json` for "this version passed the mechanical
 * gate" and `.gates/l2.json` for "this version was reviewed and closed" — and
 * refuses when either is missing for the version on disk. See `checkUnitStamps`
 * and `checkUnitReviews`.
 *
 * @module @roubaai/media/gate
 */

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
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

/** Where the L2 review verdicts are recorded, relative to the project directory. */
const REVIEW_FILE = '.gates/l2.json'

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
 * One recorded L2 review, in the shape `.handoff/闸门改造/L2凭证schema契约.md`
 * fixes (v1): who reviewed the unit, what they concluded, and the hash of the
 * text they read. That document is the single source of truth for this shape —
 * the skill writes it, this reads it, and the field names are shared verbatim.
 *
 * Every field is read structurally rather than validated up front: a
 * hand-written ledger is the normal case here, and a malformed field has to end
 * in a refusal with a nameable reason, not in a thrown error that reads like a
 * host fault.
 */
interface Review {
  /** `pass` or `needs_revision` — the reviewer's own verdict, not a summary. */
  readonly verdict?: unknown
  /** Who reviewed it. A review nobody is named for is not a review. */
  readonly reviewers?: unknown
  /**
   * The hash of the reviewed text. v1 records one string: the content hash of
   * `prompts/U0X.md`. A per-artifact map is also accepted — same wording, one
   * entry per reviewed artifact — and then every one of them is pinned.
   */
  readonly reviewedSha256?: unknown
  /** Findings the review raised: `{ open, closed, high, medium, low }`. */
  readonly findings?: unknown
  /** The user's own words, when they chose to spend anyway. */
  readonly waiver?: unknown
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
 * A refusal is one line plus a pointer, never an explanation: the reader has
 * the skill loaded, so naming the rule that failed and the document that states
 * it is enough for the next step to be obvious. Spelling out the procedure here
 * would duplicate `00-gates.md` and rot the moment it changes.
 * @param projectDir - the project directory under the asset root.
 * @param files - the unit's artifacts that exist on disk, project-relative.
 * @returns a refusal, or undefined when there is nothing to refuse.
 */
async function checkUnitStamps(projectDir: string, files: readonly string[]): Promise<GateDecision | undefined> {
  if (files.length === 0) return undefined
  const stamps = await readStamps(projectDir)

  for (const rel of files) {
    const stamp = stamps[rel]
    if (stamp === undefined) {
      return { allow: false, reason: `generate_video 被拒：${rel} 还没过 L0 闸门。参考 00-gates.md。` }
    }
    const current = sha256(await readFile(join(projectDir, rel), 'utf8'))
    if (current !== stamp.sha256) {
      return { allow: false, reason: `generate_video 被拒：${rel} 过了 L0 之后又改过，没重跑。参考 00-gates.md。` }
    }
    if (stamp.errors.length > 0) {
      const heads = stamp.errors.slice(0, 3).map(e => e.split(/[：:]/)[0]).join('、')
      const rest = stamp.errors.length > 3 ? ' 等' : ''
      return {
        allow: false,
        reason: `generate_video 被拒：${rel} 的 L0 有 ${stamp.errors.length} 个 ERROR（${heads}${rest}）。参考 00-gates.md。`,
      }
    }
  }
  return undefined
}

/** The L2 ledger's reviews, keyed by the unit id they were recorded under. */
async function readReviews(projectDir: string): Promise<Record<string, Review>> {
  try {
    const parsed = JSON.parse(await readFile(join(projectDir, REVIEW_FILE), 'utf8')) as { units?: Record<string, Review> }
    return parsed.units ?? {}
  } catch {
    return {} // 还没写过审结，或台账被改坏：当作一条都没有
  }
}

/** One artifact a review recorded: its path as written, and the hash it saw. */
interface ReviewedHash {
  /** The path exactly as the ledger spells it, so a refusal names it back. */
  readonly rel: string
  /** The file's content hash as reviewed. */
  readonly hash: string
}

/**
 * The hashes a review recorded, in whichever of the two documented shapes it used.
 *
 * v1 records one string — the hash of `prompts/U0X.md`. A map is also accepted
 * (one entry per reviewed artifact), which pins the storyboard unit file too;
 * both shapes are written down in the contract, so neither surprises the writer.
 */
type Reviewed =
  | { readonly kind: 'prompt'; readonly hash: string }
  | { readonly kind: 'map'; readonly entries: Map<string, ReviewedHash> }

/**
 * Read `reviewedSha256` in either documented shape.
 * @param record - the unit's review entry.
 * @returns the reviewed hashes, or undefined when the field is neither shape.
 */
function reviewedHashes(record: Review): Reviewed | undefined {
  const raw = record.reviewedSha256
  if (typeof raw === 'string' && raw.trim() !== '') return { kind: 'prompt', hash: raw.trim() }
  if (typeof raw !== 'object' || raw === null) return undefined
  const entries = new Map<string, ReviewedHash>()
  for (const [rel, hash] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof hash === 'string' && hash.trim() !== '') entries.set(rel.toLowerCase(), { rel, hash: hash.trim() })
  }
  return entries.size === 0 ? undefined : { kind: 'map', entries }
}

/** Findings the review left open, or undefined when that count is unreadable. */
function openFindingsOf(record: Review): number | undefined {
  const findings = record.findings
  if (typeof findings !== 'object' || findings === null) return undefined
  const value = (findings as { open?: unknown }).open
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** The reviewer ids a review names; an empty list is not a review. */
function reviewersOf(record: Review): readonly string[] {
  if (!Array.isArray(record.reviewers)) return []
  return record.reviewers.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
}

/**
 * The user's own words and the moment they said them, when they chose to spend
 * past an open verdict. A bare sentence is accepted as the words, with no moment.
 */
function waiverOf(record: Review): { readonly quote: string; readonly at: string } | undefined {
  const raw = record.waiver
  if (typeof raw === 'string' && raw.trim() !== '') return { quote: raw.trim(), at: '' }
  if (typeof raw !== 'object' || raw === null) return undefined
  const quote = (raw as { quote?: unknown }).quote
  if (typeof quote !== 'string' || quote.trim() === '') return undefined
  const at = (raw as { at?: unknown }).at
  return { quote: quote.trim(), at: typeof at === 'string' ? at.trim() : '' }
}

/** The unit's prompt artifact, which v1's single-hash form names. */
function promptFileOf(files: readonly string[], unit: string): string | undefined {
  const wanted = `prompts/${unit}.md`.toLowerCase()
  return files.find(file => file.toLowerCase() === wanted)
}

/**
 * The L2 half of the gate: a shot may only be paid for once an independent
 * reviewer has closed **this** version of the unit.
 *
 * L0 and L2 answer different questions. L0 asks whether the artifact is clean;
 * L2 asks whether anyone looked at it. Only the second is a process fact, and a
 * process fact leaves no trace on disk unless someone writes it down — which is
 * exactly how a batch of eight 64s shots was submitted on 2026-09-20 with every
 * unit clean at L0 and not one verdict closed (≈¥2.1, and all eight failed
 * review minutes later). The L0 ledger could not see it, because it was never
 * about the artifact.
 *
 * So this reads `.gates/l2.json` and refuses unless the unit is covered by a
 * `pass` with no open findings, by a named reviewer, over exactly the text on
 * disk now. A changed file is a different version: the review is void, and
 * re-running L0 does not bring it back.
 *
 * A `waiver` — the user's own words — is the one way past an open verdict, and
 * it does not reach the hash check: a waiver given about one text says nothing
 * about another. Like the L0 half, this stays out of the way until the unit has
 * artifacts to review, so a project that does not keep units this way is not
 * refused into a corner.
 * @param projectDir - the project directory under the asset root.
 * @param unit - the upper-cased unit id the call names.
 * @param files - the unit's artifacts that exist on disk, project-relative.
 * @returns a refusal, or undefined when there is nothing to refuse.
 */
async function checkUnitReviews(
  projectDir: string,
  unit: string,
  files: readonly string[],
): Promise<GateDecision | undefined> {
  if (files.length === 0) return undefined
  const refusal = (detail: string): GateDecision => ({
    allow: false,
    reason: `generate_video 被拒：${unit} ${detail}参考 00-gates.md。`,
  })

  const reviews = await readReviews(projectDir)
  const record = reviews[unit]
  if (record === undefined) return refusal('还没有 L2 审结记录。')

  if (reviewersOf(record).length === 0) return refusal('的 L2 审结没写审者（reviewers）。')

  const reviewed = reviewedHashes(record)
  if (reviewed === undefined) return refusal('的 L2 审结读不出被审版指纹（reviewedSha256）。')
  if (reviewed.kind === 'prompt') {
    // v1's single hash names the prompt artifact; without it on disk there is
    // nothing this record can be checked against.
    const prompt = promptFileOf(files, unit)
    if (prompt === undefined) return refusal('的 L2 审结没写清审的是哪一份产物（本单元没有 prompts/ 下的那一份）。')
    const current = sha256(await readFile(join(projectDir, prompt), 'utf8'))
    if (current !== reviewed.hash) return refusal('在 L2 审过之后又改过，没重审。')
  } else {
    for (const rel of files) {
      const recorded = reviewed.entries.get(rel.toLowerCase())
      if (recorded === undefined) continue // 单哈希形态只钉被点名的那一份
      const current = sha256(await readFile(join(projectDir, rel), 'utf8'))
      if (current !== recorded.hash) return refusal('在 L2 审过之后又改过，没重审。')
    }
    for (const [key, recorded] of reviewed.entries) {
      if (!files.some(file => file.toLowerCase() === key)) {
        return refusal(`的被审版里有 ${recorded.rel}，现在盘上没有这一份，审结作废。`)
      }
    }
  }

  const open = openFindingsOf(record)
  if (open === undefined) return refusal('的 L2 审结读不出 findings 关闭数（findings.open）。')
  const waiver = waiverOf(record)
  if (record.verdict === 'pass' && open === 0) return undefined
  if (waiver !== undefined && (record.verdict === 'needs_revision' || open > 0)) {
    return { allow: true, note: `generate_video: ${unit} 由用户放行（${waiver.at}）` }
  }
  const verdict = typeof record.verdict === 'string' ? record.verdict : '未写'
  return refusal(`的 L2 verdict=${verdict}，findings 还有 ${open} 条没关。`)
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
 *
 * The canvas is deliberately NOT part of this. It is a display layer the skill
 * lays only when the user asks for it, so "no canvas yet" is a legitimate state
 * of a project that is generating, not a reason to refuse one.
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
      // The rule is quoted from the document it cites, not paraphrased: a
      // refusal that says something the reference does not is worse than none.
      return {
        allow: false,
        reason: `${kind} 被拒：资产清单里没有 ${unknown.join('、')}，未列入的不生成。参考 05-asset-library.md。`,
      }
    }
    if (named.length === 0) notes.push('label 未标明资产编号')
  }

  // ② 记录（镜头）：这一版的分镜提示词过没过 L0、有没有人审过。画布不在这里查 —— 见上面
  // checkGate 的说明（画布是用户要了才铺的展示层，没铺不是拒绝的理由）。
  if (request.kind === 'video') {
    const unit = unitOf(request)
    if (unit === undefined) {
      notes.push('没标明单元号（label 里没有 U01 这类编号），无法核对 L0')
    } else {
      const files = await unitFiles(projectDir, unit)
      const stamps = await checkUnitStamps(projectDir, files)
      if (stamps !== undefined) return stamps
      // L2 只在 L0 之后问：机器说这一版干净了，才轮到问"有人看过吗"。
      const reviews = await checkUnitReviews(projectDir, unit, files)
      if (reviews !== undefined) return reviews
    }
  }

  return notes.length === 0
    ? { allow: true }
    : { allow: true, note: `${kind}: ${notes.join('；')} —— 放行但标记` }
}
