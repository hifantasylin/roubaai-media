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
 * Per-model capability is the single source of truth for what a call may ask
 * for. The resolution parameter carries NO enum: the tiers a model accepts
 * differ per generation (and per vendor release), so a list written here would
 * be a second copy of a fact the backend already owns — and it drifted exactly
 * that way, advertising a tier the configured model did not have. Instead the
 * call is validated at tool-call time against the serving provider's own
 * `capabilities()`, and a tier the configured model cannot produce is either
 * served by a sibling model that can (the result says so) or refused with a
 * message naming the model, its tiers, and its pixel floor.
 *
 * @module @roubaai/media/tools/generate-image
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { DEFAULT_IMAGE_RESOLUTION } from '../provider.ts'
import type {
  ImageGenerationResult, ImageGenerateInput, ImageProvider, ImageRunInfo, MediaModelCapability, MediaModelInfo,
} from '../provider.ts'
import { MEDIA_SETTINGS_NAMESPACE, readActiveAdapter, readActiveMediaProvider } from '../settings-lookup.ts'
import { appendMediaCost } from '../cost-ledger.ts'
import { workspaceOf } from './media-asset-save.ts'

export const name = 'generate_image'

/**
 * The label a diagnostic uses for one model: its short class name when the
 * backend states one, else the id itself. Every message the tool builds goes
 * through this, so a vendor's `lite`/`pro` wording is never re-derived here.
 */
function labelOf(capability: MediaModelCapability): string {
  return capability.label ?? capability.id
}

/**
 * Read a provider's optional per-model capability, structurally.
 *
 * A provider that implements no `capabilities()` — Maizi, mxapi — answers
 * `undefined`, and the tool then behaves exactly as it always has: no
 * validation, no substitution, the caller's tier passed straight through. A
 * provider that throws for an id it cannot place answers `undefined` too:
 * "this backend cannot describe that model" is not a failed generation, and
 * turning it into one would break a call that used to work.
 * @param provider - the image provider serving the call.
 * @param model - the model to describe; omitted describes the configured model.
 * @returns the descriptor, or `undefined` when this backend states none.
 */
function capabilityOf(provider: ImageProvider, model?: string): MediaModelCapability | undefined {
  const accessor = provider.capabilities
  if (typeof accessor !== 'function') return undefined
  try {
    return accessor.call(provider, model) ?? undefined
  } catch {
    return undefined
  }
}

/** One resolved run: the tier to ask for, plus the model override when the configured model cannot serve it. */
interface ResolvedImageRun {
  /** The tier the request carries; `undefined` leaves the provider's own default. */
  tier: string | undefined
  /** Model override, present only when the run moves to a sibling model. */
  model: string | undefined
  /**
   * The capability of the model that will actually run (the sibling's after a
   * move), or `undefined` for a backend that states none. Later checks read it
   * rather than re-asking the provider, so every bound applies to the model
   * that runs and never to the one that was asked for.
   */
  capability: MediaModelCapability | undefined
  /** The configured model, present only when the run moved away from it. */
  requestedModel?: string
  /** Short Chinese explanation of the move. */
  switchNote?: string
}

/**
 * Build the teaching error for a tier no model of this backend can produce.
 * It names what the reader needs to act: the model the call would have run on
 * (class label and id), the tiers that model declares, the pixel floor that
 * usually explains why a smaller tier is impossible, and every sibling the
 * backend lists with its own tiers — because "the id you configured cannot do
 * this" is only actionable next to what can.
 * @param active - the configured model's capability.
 * @param tier - the requested tier.
 * @param siblings - the sibling capabilities the backend states, when any.
 * @returns the one-line message.
 */
function tierMismatchMessage(
  active: MediaModelCapability,
  tier: string,
  siblings: readonly MediaModelCapability[],
): string {
  const tiers = active.tiers === undefined ? '未声明档位' : active.tiers.join('/')
  const floor = active.minPixels === undefined
    ? ''
    : `，且下限 ${active.minPixels.toLocaleString('en-US')} 像素`
  const withTiers = siblings.filter((candidate) => candidate.tiers !== undefined)
  const others = withTiers.length === 0
    ? ''
    : `；该后端已登记的模型档位：${withTiers
      .map((candidate) => `${labelOf(candidate)}（${candidate.id}）：${(candidate.tiers ?? []).join('/')}`)
      .join('，')}`
  return `generate_image: ${labelOf(active)}（${active.id}）只支持 ${tiers}${floor}；`
    + `${tier} 无法在该后端生成${others}`
}

/**
 * Ask the backend what models it currently serves, swallowing every failure.
 * The catalogue is a courtesy on this path — it is only consulted to find a
 * sibling model for a tier the configured one cannot produce — so a retired
 * key or an unreachable endpoint must not replace the real answer. The
 * `signal` is deliberately NOT forwarded: this read must finish so the error it
 * feeds can name the alternatives, and cancelling it mid-flight would turn a
 * teaching error into a transport error.
 * @param provider - the image provider serving the call.
 * @returns the listed models, or `undefined` when the backend cannot say.
 */
async function catalogueOf(provider: ImageProvider): Promise<readonly MediaModelInfo[] | undefined> {
  const list = provider.listModels
  if (typeof list !== 'function') return undefined
  try {
    return await list.call(provider) ?? []
  } catch {
    return undefined
  }
}

/**
 * The capabilities of every OTHER model the backend lists, in the backend's own
 * order. Used both to find a sibling that covers a tier the configured model
 * cannot, and to name the alternatives in the teaching error.
 * @param provider - the image provider serving the call.
 * @param catalogue - the models the backend lists.
 * @param excludeId - the configured model's id, which is not its own sibling.
 * @returns the sibling capabilities the backend states.
 */
function siblingCapabilities(
  provider: ImageProvider,
  catalogue: readonly MediaModelInfo[],
  excludeId: string,
): MediaModelCapability[] {
  const siblings: MediaModelCapability[] = []
  const seen = new Set<string>([excludeId])
  for (const model of catalogue) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    const capability = capabilityOf(provider, model.id)
    if (capability !== undefined) siblings.push(capability)
  }
  return siblings
}

/**
 * Decide which tier and model a `generate_image` call runs on, from the serving
 * provider's own per-model capability.
 *
 *  - the provider states no capability → pass through untouched (the behavior
 *    every backend without capability data has always had);
 *  - the configured model declares the tier (or declares none at all) → run it;
 *  - a SIBLING model the backend currently lists declares the tier → run the
 *    sibling and report the move, rather than failing a request the deployment
 *    can serve (the lite-class default cannot do 1.5K; the pro sibling can);
 *  - nothing can produce it → a teaching error naming the model, its tiers, its
 *    pixel floor, and the siblings with theirs.
 *
 * @param provider - the image provider serving the call.
 * @param requestedTier - the tier the caller or the active row asked for.
 * @returns the tier and any model override the request should carry.
 * @throws {Error} when no model this backend currently lists can produce the tier.
 */
async function resolveImageRun(provider: ImageProvider, requestedTier: string | undefined): Promise<ResolvedImageRun> {
  const active = capabilityOf(provider)
  if (active === undefined) return { tier: requestedTier, model: undefined, capability: undefined }
  const tier = requestedTier ?? DEFAULT_IMAGE_RESOLUTION
  if (active.tiers === undefined || active.tiers.includes(tier)) {
    return { tier, model: undefined, capability: active }
  }
  const catalogue = await catalogueOf(provider)
  const siblings = catalogue === undefined
    ? []
    : siblingCapabilities(provider, catalogue, active.id)
  const sibling = siblings.find((candidate) => candidate.tiers?.includes(tier) === true)
  if (sibling !== undefined) {
    return {
      tier,
      model: sibling.id,
      capability: sibling,
      requestedModel: active.id,
      switchNote: `${labelOf(active)}（${active.id}）不支持 ${tier}，已自动改用 ${labelOf(sibling)}（${sibling.id}）`,
    }
  }
  throw new Error(tierMismatchMessage(active, tier, siblings))
}

/**
 * Refuse a reference-image list longer than the running model's declared bound,
 * before the request is submitted — the bound is part of the same per-model
 * capability as the tiers, and a backend that states none is not validated
 * here at all (it never was).
 * @param capability - the running model's capability, when the backend states one.
 * @param count - how many reference images the call carries.
 */
function assertRefImagesWithinCapability(capability: MediaModelCapability | undefined, count: number): void {
  if (capability?.maxRefImages === undefined || count <= capability.maxRefImages) return
  throw new Error(`generate_image: ${labelOf(capability)}（${capability.id}）最多支持 `
    + `${capability.maxRefImages} 张参考图，本次请求携带 ${count} 张`)
}

/**
 * The run echo a finished image job reports. The provider's own statement wins
 * when it makes one (it alone knows the pixel size the vendor returned); a
 * provider that reports nothing gets a minimal echo built from the model the
 * result names and the tier the request carried, so the caller can still see
 * what ran. A tier neither the caller nor the provider named stays absent
 * rather than being guessed — a fabricated tier would teach the next call
 * something false.
 * @param result - the provider's result.
 * @param provider - the provider that produced it (for its default model).
 * @param tier - the tier the request carried, when it carried one.
 * @param run - the resolved run (its switch note, when the model moved).
 * @returns the echo to attach to the job result.
 */
function runInfoOf(
  result: ImageGenerationResult,
  provider: ImageProvider,
  tier: string | undefined,
  run: ResolvedImageRun,
): ImageRunInfo {
  const reported = result.run
  const model = reported?.model ?? result.providerMeta?.model ?? provider.defaultModel
  const effectiveTier = reported?.tier ?? tier
  return {
    model,
    ...effectiveTier === undefined ? {} : { tier: effectiveTier },
    ...reported?.size === undefined ? {} : { size: reported.size },
    ...run.requestedModel === undefined || run.requestedModel === model ? {} : {
      requestedModel: run.requestedModel,
      ...run.switchNote === undefined ? {} : { switchNote: run.switchNote },
    },
  }
}

export function registerGenerateImage(ctx: Context): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name,
    description: `Generate an image (text-to-image or reference-image edit). Background job: returns a job id; read the completed result via job_output (1-3 min). The finished image is displayed automatically in the conversation as this job_output tool-result card — do NOT call read_image on a generated image and do NOT paste its URL / path / JSON / Markdown into your reply to "show" it. Persist with media_asset_save (reference = the job_output JSON or its resultUrl) when the asset must outlive the 24h URL expiry. For reference edits pass refImages (public https URLs only). What a model accepts — resolution tiers, the pixel floor below which it refuses a size, how many reference images it takes, which aspect ratios it serves — is the serving adapter's OWN per-model capability and is checked at call time; this schema deliberately carries no tier list, so read the tiers from the result and the Settings page instead of assuming them. Ask for a tier the configured model cannot produce and the call either runs on a sibling model that can (the result names it and says why) or fails naming that model's allowed tiers. The completed result echoes run.model, run.tier and the returned pixel run.size so the next call can be corrected. Prefer the lowest tier that carries the detail you need.`,
    parameters: {
      prompt: { type: 'string', required: true, description: 'Image prompt' },
      refImages: {
        type: 'array',
        items: { type: 'string' },
        description: 'Reference image URLs (public https only) — an earlier generated image media URL or an attachment URL. Never base64 or local paths. The per-model maximum comes from the serving adapter\'s capability (it rejects an over-long list and names the bound).',
      },
      aspectRatio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], description: '1:1 (default) | 16:9 | 9:16 | 4:3 | 3:4.' },
      resolution: { type: 'string', description: `Resolution tier (e.g. 1K | 1.5K | 2K | 3K | 4K). The accepted set is PER MODEL and is validated at call time against the serving adapter's own capability — a tier the configured model cannot produce is served by a sibling model that can (the result names it and says why) or refused with that model's allowed tiers and pixel floor. Defaults to ${DEFAULT_IMAGE_RESOLUTION}.` },
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
      // Tier priority: the call's own argument, else the active row's stored
      // preference, else the seam default — and every one of them is subject to
      // the model's capability below, so a stored tier cannot outlive the model
      // it was chosen for.
      const rowTier = readActiveMediaProvider(ctx, MEDIA_SETTINGS_NAMESPACE, 'image').resolution
      const run = await resolveImageRun(provider, args.resolution ?? rowTier)
      assertRefImagesWithinCapability(run.capability, args.refImages?.length ?? 0)
      const input: ImageGenerateInput = {
        prompt: args.prompt,
        ...run.model === undefined ? {} : { model: run.model },
        ...args.refImages !== undefined ? { refImages: args.refImages } : {},
        ...args.aspectRatio !== undefined ? { aspectRatio: args.aspectRatio } : {},
        ...run.tier === undefined ? {} : { resolution: run.tier },
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
                // The model the generation actually ran: an explicit override
                // (the sibling switch above) beats the provider's configured
                // model, which itself beats its default. Reading `defaultModel`
                // here would bill the default's rate for a run that used
                // another model.
                const model = result.providerMeta?.model ?? provider.defaultModel
                const costUsd = provider.estimateCostUsd(model, run.tier ?? '1K')
                await appendMediaCost(workspace, {
                  ts: Date.now(),
                  tool: 'image',
                  model,
                  project: args.project ?? workspace,
                  ...args.label !== undefined ? { label: args.label } : {},
                  spec: run.tier ?? '1K',
                  costUsd: costUsd ?? 0,
                  source: 'estimated',
                  taskId: provider.provider,
                })
              } catch (costError) {
                ctx.logger.warn(`media cost ledger append failed: ${String(costError)}`)
              }
              // Echo what ran (model, tier, and the vendor's returned pixel
              // size) so the caller can self-correct on its next call.
              const runInfo = runInfoOf(result, provider, run.tier, run)
              return {
                status: 'completed',
                output: JSON.stringify({ ...result, run: runInfo }),
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
