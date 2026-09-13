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


/**
 * Ledger file for one project: `<assetsRoot>/<project>/media-cost.jsonl`.
 * A missing project — or one that is actually an absolute path, which no project
 * name is — falls back to `<assetsRoot>/default/media-cost.jsonl`, so a run that
 * names no project still records its cost under `default` rather than under a
 * mangled absolute-path directory.
 * @param assetsRoot - the asset root, resolved by `asset-root`.
 * @param project - the project folder name, or undefined for the default.
 * @returns the absolute ledger path.
 */
export function ledgerPath(assetsRoot: string, project: string | undefined): string {
  const dir = project === undefined || project.length === 0 || isAbsolute(project)
    ? DEFAULT_PROJECT
    : project.replace(/[\\/:*?"<>|]/g, '_')
  return join(assetsRoot, dir, 'media-cost.jsonl')
}

/** The project a run without one is recorded under. */
export const DEFAULT_PROJECT = 'default'

/**
 * True when the same (project, label) already exists in the ledger.
 * @param assetsRoot - the asset root.
 * @param project - the project folder name.
 * @param label - the run label, when the caller gave one.
 * @returns whether this exact run already happened.
 */
export async function isRetry(assetsRoot: string, project: string, label: string | undefined): Promise<boolean> {
  if (label === undefined) return false
  const entries = await readLedger(assetsRoot, project)
  return entries.some(entry => entry.project === project && entry.label === label)
}

/**
 * Append one completion record; `retry` is computed automatically.
 * @param assetsRoot - the asset root.
 * @param entry - the record, without its computed `retry` flag.
 * @returns the complete record.
 */
export async function appendMediaCost(
  assetsRoot: string,
  entry: Omit<MediaCostEntry, 'retry'>,
): Promise<MediaCostEntry> {
  const full: MediaCostEntry = { ...entry, retry: await isRetry(assetsRoot, entry.project, entry.label) }
  const filePath = ledgerPath(assetsRoot, entry.project)
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
 * (`<assetsRoot>/<project>/media-cost.jsonl`); without one, scans every project
 * directory under the asset root (including `default`) so a user-wide summary
 * folds all projects together.
 * @param assetsRoot - the asset root.
 * @param project - the project folder name, or undefined for every project.
 * @returns the recorded entries.
 */
export async function readLedger(assetsRoot: string, project?: string): Promise<MediaCostEntry[]> {
  if (project !== undefined) return readLedgerFile(ledgerPath(assetsRoot, project))
  let dirs: string[]
  try {
    dirs = (await readdir(assetsRoot, { withFileTypes: true }))
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)
  } catch {
    return []
  }
  const all: MediaCostEntry[] = []
  for (const dir of dirs) {
    all.push(...await readLedgerFile(join(assetsRoot, dir, 'media-cost.jsonl')))
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

/**
 * Fold the ledger into a summary (newest label first).
 * @param assetsRoot - the asset root.
 * @param filter - optional project and time window.
 * @returns the folded summary.
 */
export async function summarizeMediaCost(
  assetsRoot: string,
  filter?: { project?: string; since?: number },
): Promise<MediaCostSummary> {
  const all = await readLedger(assetsRoot, filter?.project)
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
