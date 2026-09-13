/**
 * `media_cost_summary` tool: fold the automatic media cost ledger
 * (`<assetsRoot>/<project>/media-cost.jsonl`, written by the generate_* tools on
 * every completion) into a model/owner-readable total. Used when the user asks
 * about cost, or when the cost-tracker document needs an actual-vs-expected
 * refresh — the ledger itself is automatic, so this tool never depends on the
 * agent remembering to record anything.
 *
 * @module @roubaai/media/tools/media-cost-summary
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { summarizeMediaCost, MediaCostSummary } from '../cost-ledger.ts'
import { assetsRoot } from '../asset-root.ts'

export const name = 'media_cost_summary'

/** One-line USD renderer. */
function usd(n: number): string {
  return `$${n.toFixed(4)}`
}

/** Fold the summary into a compact markdown block for the caller. */
export function renderSummary(summary: MediaCostSummary, projectLabel: string): string {
  const lines: string[] = []
  lines.push(
    `媒体成本账（${projectLabel}）：共 ${summary.totalCount} 次生成，合计 ${usd(summary.totalUsd)}，其中重试 ${summary.retryCount} 次 ${usd(summary.retryUsd)}`,
  )
  for (const label of summary.byLabel) {
    lines.push(`- ${label.label}（${label.project}）：首次 ${usd(label.firstUsd)}，重试 ${label.retries} 次，累计 ${usd(label.totalUsd)}`)
  }
  if (summary.byLabel.length === 0) lines.push('-（无带 label 的记录）')
  const tools = summary.byTool.map(t => `${t.tool}×${t.count}=${usd(t.totalUsd)}`).join(' ｜ ')
  lines.push(`按类型：${tools}`)
  return lines.join('\n')
}

export function registerMediaCostSummary(ctx: Context): () => void {
  return ctx.tools.register(defineTool({
    name,
    description: 'Read the automatic media cost ledger (written by generate_image / generate_video / generate_music on every completion) and summarize actual spend, grouped by label (shot/asset) with retry counts. Use when the user asks how much a project/shot cost, or when refreshing the cost-tracker document.',
    parameters: {
      project: {
        type: 'string',
        description: 'Filter by project name (e.g. 奇幻超人). Default: every project. Entries recorded without a project are filed under default.',
      },
      since: {
        type: 'string',
        description: 'Only count records at or after this ISO 8601 time (e.g. 2026-08-31T00:00:00Z). Default: all.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          totalUsd: { type: 'number', required: true },
          totalCount: { type: 'number', required: true },
          retryCount: { type: 'number', required: true },
          retryUsd: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const assets = assetsRoot()
      let since: number | undefined
      if (args.since !== undefined) {
        const parsed = Date.parse(args.since)
        if (Number.isNaN(parsed)) throw new Error('media_cost_summary: since must be an ISO 8601 date')
        since = parsed
      }
      const summary = await summarizeMediaCost(assets, {
        ...args.project !== undefined ? { project: args.project } : {},
        ...since !== undefined ? { since } : {},
      })
      const projectLabel = args.project ?? '全部项目'
      const text = renderSummary(summary, projectLabel)
      return {
        text,
        totalUsd: summary.totalUsd,
        totalCount: summary.totalCount,
        retryCount: summary.retryCount,
        retryUsd: summary.retryUsd,
      }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: 'Media cost summary', kind: 'execute', rawInput: args.project ?? 'all projects' }
    },
  }))
}
