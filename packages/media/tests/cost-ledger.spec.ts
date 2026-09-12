import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  appendMediaCost,
  estimateImageCostUsd,
  estimateVideoCostUsd,
  summarizeMediaCost,
} from '../src/cost-ledger.ts'

describe('cost-ledger', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-cost-ledger-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('estimates image cost from model + resolution', () => {
    expect(estimateImageCostUsd('gpt-image-2', '1K')).toBe(0.009)
    expect(estimateImageCostUsd('gpt-image-2', '4K')).toBe(0.044)
    expect(estimateImageCostUsd('nano-banana-2', 'any')).toBe(0.018)
    expect(estimateImageCostUsd('unknown-model', '1K')).toBeUndefined()
  })

  it('estimates video cost from model + duration + resolution', () => {
    expect(estimateVideoCostUsd('doubao-seedance-2.0-fast', 4, '480p')).toBeCloseTo(0.2548)
    expect(estimateVideoCostUsd('doubao-seedance-2.5', 5, '720p')).toBeCloseTo(1.35)
    expect(estimateVideoCostUsd('doubao-seedance-2.0', 4, '9999p')).toBeUndefined()
  })

  it('flags the second occurrence of the same (project, label) as a retry', async () => {
    const base = {
      ts: Date.now(),
      tool: 'video' as const,
      model: 'stub-video-v1',
      project: '奇幻超人',
      spec: '4s×480p',
      costUsd: 0.2548,
      source: 'reported' as const,
    }
    const first = await appendMediaCost(dir, { ...base, label: 'EP01_镜01' })
    const second = await appendMediaCost(dir, { ...base, label: 'EP01_镜01' })
    const other = await appendMediaCost(dir, { ...base, label: 'EP01_镜02' })
    expect(first.retry).toBe(false)
    expect(second.retry).toBe(true)
    expect(other.retry).toBe(false)
  })

  it('summarizes totals, retries, per-label and per-tool costs', async () => {
    await appendMediaCost(dir, { ts: 1, tool: 'video', model: 'm', project: 'p', label: 'A', spec: '4s', costUsd: 1, source: 'reported' })
    await appendMediaCost(dir, { ts: 2, tool: 'video', model: 'm', project: 'p', label: 'A', spec: '4s', costUsd: 2, source: 'reported' })
    await appendMediaCost(dir, { ts: 3, tool: 'image', model: 'gpt-image-2', project: 'p', label: 'B', spec: '1K', costUsd: 0.009, source: 'estimated' })

    const summary = await summarizeMediaCost(dir, { project: 'p' })
    expect(summary.totalCount).toBe(3)
    expect(summary.totalUsd).toBeCloseTo(3.009)
    expect(summary.retryCount).toBe(1)
    expect(summary.retryUsd).toBeCloseTo(2)

    const label = summary.byLabel.find(l => l.label === 'A')
    expect(label).toBeDefined()
    expect(label!.firstUsd).toBe(1)
    expect(label!.retries).toBe(1)
    expect(label!.totalUsd).toBeCloseTo(3)

    const tool = summary.byTool.find(t => t.tool === 'image')
    expect(tool).toBeDefined()
    expect(tool!.count).toBe(1)
    expect(tool!.totalUsd).toBeCloseTo(0.009)
  })

  it('filters by project and since', async () => {
    await appendMediaCost(dir, { ts: 100, tool: 'image', model: 'm', project: 'a', spec: '1K', costUsd: 1, source: 'estimated' })
    await appendMediaCost(dir, { ts: 200, tool: 'image', model: 'm', project: 'b', spec: '1K', costUsd: 2, source: 'estimated' })

    const byProject = await summarizeMediaCost(dir, { project: 'b' })
    expect(byProject.totalCount).toBe(1)
    expect(byProject.totalUsd).toBeCloseTo(2)

    const since = await summarizeMediaCost(dir, { since: 150 })
    expect(since.totalCount).toBe(1)
    expect(since.totalUsd).toBeCloseTo(2)
  })
})
