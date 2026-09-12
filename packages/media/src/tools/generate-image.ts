/**
 * `generate_image` tool: text-to-image / reference-image edit via a configured
 * media provider, run as a `ctx.jobs` background task. Image generation takes
 * tens of seconds to minutes (Maizi's synchronous endpoint blocks until the
 * server has generated the image), so the foreground `execute` only starts the
 * job and returns the id — it never blocks on the provider call. The model
 * reads the full result (attachment reference + 24h result URL) through
 * `job_output`; no completion message is pushed into the session, which would
 * otherwise pile up as queued messages and force extra model turns.
 *
 * @module @roubaai/media/tools/generate-image
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { ImageGenerateInput } from '../provider.ts'
import { readActiveAdapter } from '../settings-lookup.ts'
import { appendMediaCost } from '../cost-ledger.ts'
import { workspaceOf } from './media-asset-save.ts'

export const name = 'generate_image'

export function registerGenerateImage(ctx: Context): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name,
    description: 'Generate an image (text-to-image or reference-image edit; default model gpt-image-2). Background job: returns a job id; read the completed result via job_output (1-3 min). The finished image is displayed automatically in the conversation as this job_output tool-result card — do NOT call read_image on a generated image and do NOT paste its URL / path / JSON / Markdown into your reply to "show" it. Persist with media_asset_save (reference = the job_output JSON or its resultUrl) when the asset must outlive the 24h URL expiry. For reference edits pass refImages (public https URLs only, max 9). COST per image: gpt-image-2 $0.009/1K, $0.029/2K, $0.044/4K; prefer 1K.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Image prompt' },
      refImages: {
        type: 'array',
        items: { type: 'string' },
        description: 'Reference image URLs (public https only, max 9) — an earlier generated image media URL or an attachment URL. Never base64 or local paths.',
      },
      aspectRatio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], description: '1:1 (default) | 16:9 | 9:16 | 4:3 | 3:4.' },
      resolution: { type: 'string', enum: ['1K', '2K', '4K'], description: '1K (default, cheapest) | 2K | 4K.' },
      quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'low (default) | medium | high.' },
      project: { type: 'string', description: '成本记账用：当前项目名（如 奇幻超人），用于媒体成本账归档；不传则归到工作空间。' },
      label: { type: 'string', description: '成本记账用：本资产标识（如 EP01_镜02_镇民躲藏）；同一 (project,label) 第二次出现自动记为重试。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'background' },
          jobId: { type: 'string', required: true },
          taskId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Started background image job ${value.jobId}; read the result via job_output when it completes` }],
    },
    // oxlint-disable-next-line typescript/require-await -- async matches the ToolDefinition.execute contract
    async execute(args, exec) {
      if (args.prompt.trim().length === 0) {
        throw new Error('generate_image: prompt must be a non-empty string')
      }
      // Route through the backend the Settings page activated for images. An
      // unconfigured deployment names none, and keeps whatever single provider
      // its composition registered — the behavior it has always had.
      const adapter = readActiveAdapter(ctx, 'image')
      const provider = adapter === undefined ? ctx.media.image() : ctx.media.image(adapter)
      const input: ImageGenerateInput = {
        prompt: args.prompt,
        ...args.refImages !== undefined ? { refImages: args.refImages } : {},
        ...args.aspectRatio !== undefined ? { aspectRatio: args.aspectRatio } : {},
        ...args.resolution !== undefined ? { resolution: args.resolution } : {},
        ...args.quality !== undefined ? { quality: args.quality } : {},
      }
      // Start the background job; `run()` owns the provider call (which blocks
      // on Maizi's synchronous image generation) under its own AbortController,
      // decoupled from `exec.signal` once the job id is published.
      const jobId = ctx.jobs.start({
        kind: 'media-image',
        label: `generate_image:${provider.provider}`,
        ...exec.agent !== undefined ? { owner: exec.agent } : {},
        run: () => {
          const ac = new AbortController()
          const done = (async (): Promise<JobOutcome> => {
            try {
              const result = await provider.generate(input, ac.signal)
              // Automatic cost accounting: images report no USD cost, so the
              // provider prices the run by the model the result names and the
              // resolution. A ledger write failure must never fail the
              // generation itself.
              try {
                const workspace = workspaceOf(exec.agent)
                // The model the generation actually ran: an image input carries
                // no model field, so the provider decides — a Settings-page
                // override beats its configured default — and names the winner
                // in the result. Reading `defaultModel` here would bill the
                // default's rate for a run that used another model.
                const model = result.providerMeta?.model ?? provider.defaultModel
                const costUsd = provider.estimateCostUsd(model, args.resolution ?? '1K')
                await appendMediaCost(workspace, {
                  ts: Date.now(),
                  tool: 'image',
                  model,
                  project: args.project ?? workspace,
                  ...args.label !== undefined ? { label: args.label } : {},
                  spec: args.resolution ?? '1K',
                  costUsd: costUsd ?? 0,
                  source: 'estimated',
                  taskId: provider.provider,
                })
              } catch (costError) {
                ctx.logger.warn(`media cost ledger append failed: ${String(costError)}`)
              }
              return {
                status: 'completed',
                output: JSON.stringify(result),
              }
            } catch (error) {
              if (ac.signal.aborted) return { status: 'killed' }
              return { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
            }
          })()
          return {
            cancel: (reason?: string) => {
              ac.abort(reason)
            },
            done,
          }
        },
      })
      return { kind: 'background' as const, jobId, taskId: provider.provider }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: 'Generate image', kind: 'execute', rawInput: args.prompt }
    },
  })))

  // No completion followup: the job result (attachment reference + 24h result
  // URL) is read by the model through `job_output`. A pushed message would
  // pile up in the session's queued-message tray and force extra model turns.

  // Monotonic deny guard: no provider (`NO_PROVIDER`) is a final deny.
  disposers.push(ctx.tools.guard((execution: Readonly<ToolExecution>) => {
    if (execution.name !== name) return undefined
    try {
      const adapter = readActiveAdapter(ctx, 'image')
      if (adapter === undefined) ctx.media.image()
      else ctx.media.image(adapter)
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'NO_PROVIDER') {
        return 'no image provider is configured'
      }
    }
    return undefined
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
