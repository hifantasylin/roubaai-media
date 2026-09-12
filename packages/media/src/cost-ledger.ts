/**
 * Media cost ledger — automatic, append-only per-completion record of media
 * generation cost. The `generate_image` / `generate_video` / `generate_music`
 * tools write one line per completed job themselves, so cost tracking is
 * reliable even when the agent forgets to record it. The ledger lives at
 * `<workspace>/.assets/media-cost.jsonl` (one JSON object per line); the
 * `media_cost_summary` tool folds it into an owner/model-readable total and
 * drives the cost-tracker document's actual-vs-expected comparison.
 *
 * @module @roubaai/media/cost-ledger
 */

import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

/** One ledger line, written on every media job completion. */
export interface MediaCostEntry {
  /** Completion timestamp (ms). */
  ts: number
  tool: 'image' | 'video' | 'music'
  model: string
  /** LLM-provided project name (奇幻超人); falls back to the workspace when absent. */
  project: string
  /** LLM-provided shot identifier (EP01_镜02_镇民躲藏); drives retry detection. */
  label?: string
  /** Readable spec: image resolution | video duration×resolution | music duration. */
  spec: string
  /** USD cost; provider-reported for video, estimated from the rate table otherwise. */
  costUsd: number
  /** reported = provider returned a real cost; estimated = rate-table lookup. */
  source: 'reported' | 'estimated'
  taskId?: string
  /** Same (project, label) already present in the ledger => this is a retry. */
  retry: boolean
}

/** Image rate table keyed `model/resolution`; a matching `any` entry covers unknown resolutions. */
const IMAGE_COST_USD: Record<string, number> = {
  'gpt-image-2/1k': 0.009,
  'gpt-image-2/2k': 0.029,
  'gpt-image-2/4k': 0.044,
  'nano-banana-fast/1k': 0.009,
  'nano-banana-2/any': 0.018,
}

/** Video rate table keyed `model/resolution`; USD per second. */
const VIDEO_COST_USD_PER_SECOND: Record<string, number> = {
  'doubao-seedance-2.0-fast/480p': 0.0637,
  'doubao-seedance-2.0-fast/720p': 0.137,
  'doubao-seedance-2.0/480p': 0.0792,
  'doubao-seedance-2.0/720p': 0.1704,
  'doubao-seedance-2.0/1080p': 0.4253,
  'doubao-seedance-2.5/480p': 0.1201,
  'doubao-seedance-2.5/720p': 0.27,
}

/** Estimate an image's USD cost from its model and resolution, when known. */
export function estimateImageCostUsd(model: string, resolution: string): number | undefined {
  return IMAGE_COST_USD[`${model}/${resolution.toLowerCase()}`] ?? IMAGE_COST_USD[`${model}/any`]
}

/** Estimate a video's USD cost from its model, duration and resolution, when known. */
export function estimateVideoCostUsd(model: string, duration: number, resolution: string): number | undefined {
  const perSecond = VIDEO_COST_USD_PER_SECOND[`${model}/${resolution}`]
  return perSecond === undefined ? undefined : perSecond * duration
}

/**
 * Ledger file for one project: `<workspace>/.assets/<project>/media-cost.jsonl`.
 * A missing project — or one that is actually the workspace path itself (the
 * generate tools fall back to the workspace when the model omits `project`) —
 * falls back to `<workspace>/.assets/default/media-cost.jsonl`, so the
 * workspace's cost data stays in the workspace `.assets` tree under the
 * `default` project rather than under a mangled absolute-path directory.
 */
export function ledgerPath(workspace: string, project: string | undefined): string {
  // Only a relative project name (e.g. `奇幻超人`) is a real project directory;
  // an absent value or an absolute path (the workspace fallback) is unscoped.
  const dir = project === undefined || project.length === 0 || isAbsolute(project)
    ? 'default'
    : project.replace(/[\\/:*?"<>|]/g, '_')
  return join(workspace, '.assets', dir, 'media-cost.jsonl')
}

/** True when the same (project, label) already exists in the ledger. */
export async function isRetry(workspace: string, project: string, label: string | undefined): Promise<boolean> {
  if (label === undefined) return false
  const entries = await readLedger(workspace, project)
  return entries.some(entry => entry.project === project && entry.label === label)
}

/** Append one completion record; `retry` is computed automatically. Returns the full record. */
export async function appendMediaCost(
  workspace: string,
  entry: Omit<MediaCostEntry, 'retry'>,
): Promise<MediaCostEntry> {
  const full: MediaCostEntry = { ...entry, retry: await isRetry(workspace, entry.project, entry.label) }
  const filePath = ledgerPath(workspace, entry.project)
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, `${JSON.stringify(full)}\n`, 'utf8')
  return full
}

/** Read one ledger file, skipping malformed lines. */
async function readLedgerFile(filePath: string): Promise<MediaCostEntry[]> {
  let content = ''
  try {
    content = await readFile(filePath, 'utf8')
  } catch {
    return []
  }
  const entries: MediaCostEntry[] = []
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      entries.push(JSON.parse(line) as MediaCostEntry)
    } catch { /* skip malformed */ }
  }
  return entries
}

/**
 * Read ledger entries. With a project, reads only that project's file
 * (`<workspace>/.assets/<project>/media-cost.jsonl`); without one, scans every
 * project directory under `.assets/` (including `default`) so a workspace-wide
 * summary folds all projects together.
 */
export async function readLedger(workspace: string, project?: string): Promise<MediaCostEntry[]> {
  if (project !== undefined) return readLedgerFile(ledgerPath(workspace, project))
  const assetsDir = join(workspace, '.assets')
  let dirs: string[]
  try {
    dirs = (await readdir(assetsDir, { withFileTypes: true }))
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)
  } catch {
    return []
  }
  const all: MediaCostEntry[] = []
  for (const dir of dirs) {
    all.push(...await readLedgerFile(join(assetsDir, dir, 'media-cost.jsonl')))
  }
  return all
}

/** A per-label fold: first cost, retry count, total cost. */
export interface LabelCost {
  project: string
  label: string
  firstUsd: number
  retries: number
  totalUsd: number
  lastTs: number
}

/** Cost summary folded from the ledger, optionally filtered by project / since. */
export interface MediaCostSummary {
  totalUsd: number
  totalCount: number
  retryCount: number
  retryUsd: number
  byLabel: LabelCost[]
  byTool: Array<{ tool: MediaCostEntry['tool']; count: number; totalUsd: number }>
}

/** Fold the ledger into a summary (newest label first). */
export async function summarizeMediaCost(
  workspace: string,
  filter?: { project?: string; since?: number },
): Promise<MediaCostSummary> {
  const all = await readLedger(workspace, filter?.project)
  const entries = all.filter(entry =>
    (filter?.since === undefined || entry.ts >= filter.since),
  )

  const byLabel = new Map<string, LabelCost>()
  const byTool = new Map<MediaCostEntry['tool'], { tool: MediaCostEntry['tool']; count: number; totalUsd: number }>()
  let totalUsd = 0
  let retryCount = 0
  let retryUsd = 0

  for (const entry of entries) {
    totalUsd += entry.costUsd
    if (entry.retry) {
      retryCount++
      retryUsd += entry.costUsd
    }
    const tool = byTool.get(entry.tool) ?? { tool: entry.tool, count: 0, totalUsd: 0 }
    tool.count++
    tool.totalUsd += entry.costUsd
    byTool.set(entry.tool, tool)
    if (entry.label !== undefined) {
      const key = `${entry.project}\u0000${entry.label}`
      const prior = byLabel.get(key)
      if (prior === undefined) {
        byLabel.set(key, {
          project: entry.project,
          label: entry.label,
          firstUsd: entry.costUsd,
          retries: entry.retry ? 1 : 0,
          totalUsd: entry.costUsd,
          lastTs: entry.ts,
        })
      } else {
        prior.retries += entry.retry ? 1 : 0
        prior.totalUsd += entry.costUsd
        prior.lastTs = Math.max(prior.lastTs, entry.ts)
      }
    }
  }

  return {
    totalUsd,
    totalCount: entries.length,
    retryCount,
    retryUsd,
    byLabel: [...byLabel.values()].sort((a, b) => b.totalUsd - a.totalUsd),
    byTool: [...byTool.values()].sort((a, b) => b.totalUsd - a.totalUsd),
  }
}
