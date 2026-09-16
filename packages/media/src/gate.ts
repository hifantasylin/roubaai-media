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

  const manifestPath = await findManifest(join(request.assetsRoot, project))
  if (manifestPath === undefined) {
    return { allow: true, note: `${kind}: 项目「${project}」还没有资产清单 —— 放行但标记` }
  }

  const ids = manifestIds(await readFile(manifestPath, 'utf8'))
  const named = labelIds(request.label ?? '')
  const unknown = named.filter(id => !ids.has(id))
  if (unknown.length > 0) {
    return {
      allow: false,
      reason: `${kind}: 资产清单里没有 ${unknown.join('、')}（清单共 ${ids.size} 项）。`
        + '这一项不在规范内 —— 拒绝。'
        + '要加的话得从上游加起（先改讲戏本），不能在下游凭空插。',
    }
  }

  return named.length === 0
    ? { allow: true, note: `${kind}: label 未标明资产编号，放行但标记（project=${project}）` }
    : { allow: true }
}
