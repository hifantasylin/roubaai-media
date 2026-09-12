/**
 * Volcengine Ark image provider — the vendor's synchronous image API
 * (`POST {base}/images/generations`, Seedream models).
 *
 * This adapter calls Ark directly with a deployment's own `ARK_API_KEY`, so a
 * deployment can run Seedream without routing through an aggregator. The seam's
 * provider-neutral input maps onto Ark's flat body here: `refImages` becomes the
 * `image` field (one reference as a bare string, several as an array), and the
 * requested geometry becomes either an explicit `WxH` pixel size — looked up in
 * Ark's documented per-generation table — or the resolution tier string Ark
 * accepts on its own.
 *
 * Ark model ids embed a release/date segment and retire, so nothing here
 * hardcodes one beyond the configurable default: {@link ArkImageProvider.listModels}
 * asks the backend what it serves, and a submission refused for an unknown id
 * reports that list instead of a generic failure.
 *
 * Per-model capability lives in ONE table here ({@link IMAGE_GENERATIONS}),
 * which {@link ArkImageProvider.capabilities} hands to the tool and the
 * Settings page. Everything a request may name — resolution tiers, the pixel
 * floor, the reference bound — is read from it, so a vendor tier change is a
 * one-line edit rather than a hunt for the second copy of the fact.
 *
 * Ark prices in RMB with vendor-specific discounts and tiers, so this adapter
 * reports no USD estimate — the ledger records the run unpriced rather than
 * converting at a rate this package does not own.
 * @module @roubaai/media-ark/ark-image-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { ImageProvider, readActiveMediaProvider } from '@roubaai/media'
import type {
  ImageCaps, ImageGenerationResult, ImageGenerateInput, ImageRunInfo, MediaModelCapability,
  MediaModelInfo, MediaProgress, ProviderProbeDraft, ProviderProbeResult,
} from '@roubaai/media'
import {
  arkErrorDetail, arkStatusMeaning, ArkHttpError, ArkNetworkError, downloadBytes, getJson,
  isModelNotFound, isNetworkError, postJson,
} from './http.ts'
import { fetchArkModels, formatModelIds } from './ark-models.ts'
import { arkUnconfiguredReason, resolveArkKey } from './credentials.ts'
import { MissingCredentialError } from './errors.ts'
import { DEFAULT_SETTINGS_NAMESPACE } from './settings-config.ts'

export { MissingCredentialError } from './errors.ts'

/** Credential reference for the Ark API key (shared with the video provider). */
export const ARK_API_KEY_REF = 'ARK_API_KEY'

/**
 * Fallback image model, Ark's plain (non-"pro") Seedream 5.0 id — the lite
 * class. It is the default because it is the tier this deployment runs for
 * ordinary work and the one whose bounds are widest (2K through 4K); a request
 * that needs a tier only the pro sibling serves is moved there automatically by
 * the tool. Ark re-dates these ids between releases, so this is a default to
 * start from, never a guarantee: `listModels()` reports what the deployment may
 * actually request.
 */
export const DEFAULT_IMAGE_MODEL = 'doubao-seedream-5-0-260128'

/** Ark's public API base (cn-beijing region). */
export const ARK_IMAGE_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

/**
 * Conservative result-URL lifetime. Ark states no expiry for the produced file,
 * so the 24h download policy the other adapters use is applied here too.
 */
const MEDIA_URL_TTL_MS = 24 * 60 * 60_000

/** Upper bound on a downloaded image result (Ark image results are a few MB). */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Resolution tier Ark is asked for when the caller names none. */
const DEFAULT_RESOLUTION_TIER = '2K'

/**
 * Ark's documented pixel size per aspect ratio and resolution tier. The tier
 * LABELS are universal; which of them a given model supports is per generation
 * (see {@link IMAGE_GENERATIONS}), so this table is only consulted for a tier
 * the model may actually be asked for. A missing cell (Ark states no 3K size
 * for 4:3 / 3:4 / 3:2 / 2:3) falls back to the tier string.
 */
const PIXELS_BY_RATIO: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '21:9': { '1K': '1568x672', '1.5K': '2352x1008', '2K': '3136x1344', '3K': '4704x2016', '4K': '6240x2656' },
  '16:9': { '1K': '1424x800', '1.5K': '2048x1152', '2K': '2816x1584', '3K': '4096x2304', '4K': '5504x3040' },
  '9:16': { '1K': '800x1424', '1.5K': '1152x2048', '2K': '1584x2816', '3K': '2304x4096', '4K': '3040x5504' },
  '1:1': { '1K': '1024x1024', '1.5K': '1536x1536', '2K': '2048x2048', '3K': '3072x3072', '4K': '4096x4096' },
  '4:3': { '1K': '1152x864', '1.5K': '1792x1344', '2K': '2368x1776', '4K': '4704x3520' },
  '3:4': { '1K': '864x1152', '1.5K': '1344x1792', '2K': '1776x2368', '4K': '3520x4704' },
  '3:2': { '1K': '1248x832', '1.5K': '1872x1248', '2K': '2496x1664', '4K': '4992x3328' },
  '2:3': { '1K': '832x1248', '1.5K': '1248x1872', '2K': '1664x2496', '4K': '3328x4992' },
}

/** One image generation's bounds, matched against the model id. */
interface ArkImageGeneration {
  /** Fragment identifying the generation inside the model id. */
  readonly match: RegExp
  /** Short class label (`pro`, `lite`, `4.5`) the diagnostic text can use. */
  readonly label: string
  /** Resolution tiers this generation accepts. */
  readonly resolutions: readonly string[]
  /** Reference images this generation accepts on one request. */
  readonly maxRefImages: number
  /**
   * Pixel floor Ark enforces for this generation, when it states one: a request
   * whose resolved size is smaller is refused. It is also WHY the tiers below
   * it are absent from `resolutions` — a 1.5K cell is ~2.36 MP, physically
   * under this floor, so the tier does not exist for this model at all.
   */
  readonly minPixels?: number
  /**
   * Whether Ark accepts `sequential_image_generation` for this generation.
   *
   * The pro generation draws one image per request and the vendor states it
   * does not support configuring that field, so sending it fails the whole
   * request with 400 before anything is drawn. Only a generation verified to
   * accept the field carries it; an unplaced or unverified one does not, which
   * costs nothing because this adapter only ever asks for a single image.
   */
  readonly acceptsSequential?: boolean
  /** Short Chinese hint the Settings page shows beside this model. */
  readonly note: string
}

/** Pixel floor Ark enforces on the plain 5.0 (lite class) generation. */
const LITE_MIN_PIXELS = 3_686_400

/**
 * Per-generation bounds, matched against the model id IN ORDER — so the two
 * 5.0 entries must stay above the plain-5.0 catch-all that follows them.
 *
 * Every pattern requires a NON-DIGIT before the version digit. Without that
 * guard a release date matches too: `doubao-seedream-4-0-250828` contains the
 * digits `50` inside its date segment, so a bare `/5[-_.]?0/` classified a 4.0
 * model as the lite class and handed it the wrong tiers and floor. The same
 * guard keeps a future `…-6-0-240040` from reading as 4.0.
 *
 * The plain, non-"pro" Seedream 5.0 (`doubao-seedream-5-0-260128`) is the lite
 * class: Ark accepts only `'WIDTHxHEIGHT' | '2k' | '3k' | '4k'` for it and
 * refuses anything under 3,686,400 pixels, which is why 1.5K (~2.36 MP) is
 * physically impossible there rather than merely unlisted. Before this entry
 * existed, that id matched neither the pro nor the lite pattern and fell
 * through to "generation unknown" — the wrong answer for a model whose real
 * bounds are the strictest of the set.
 */
const IMAGE_GENERATIONS: readonly ArkImageGeneration[] = [
  {
    match: /(?:^|[^0-9])5[-_.]?0[-_.]?pro/i,
    label: 'pro',
    resolutions: ['1K', '1.5K', '2K'],
    maxRefImages: 10,
    note: 'pro 档：有 1.5K 中间档，支持多图参考与精细编辑',
  },
  {
    match: /(?:^|[^0-9])5[-_.]?0[-_.]?lite/i,
    label: 'lite',
    resolutions: ['2K', '3K', '4K'],
    maxRefImages: 14,
    minPixels: LITE_MIN_PIXELS,
    acceptsSequential: true,
    note: 'lite 档：2K 起，档位越高细节越多，适合试构图与大图',
  },
  {
    // The plain 5.0 id carries no pro/lite segment; it IS the lite class. The
    // lookahead keeps this catch-all from claiming a pro/lite id if the two
    // entries above are ever reordered.
    match: /(?:^|[^0-9])5[-_.]?0(?![-_.]?(?:pro|lite))/i,
    label: 'lite',
    resolutions: ['2K', '3K', '4K'],
    maxRefImages: 14,
    minPixels: LITE_MIN_PIXELS,
    acceptsSequential: true,
    note: 'lite 档：2K 起，档位越高细节越多，适合试构图与大图',
  },
  {
    match: /(?:^|[^0-9])4[-_.]?5/i,
    label: '4.5',
    resolutions: ['2K', '4K'],
    maxRefImages: 14,
    note: '4.5 代：2K / 4K 两档',
  },
  {
    match: /(?:^|[^0-9])4[-_.]?0/i,
    label: '4.0',
    resolutions: ['1K', '2K', '4K'],
    maxRefImages: 14,
    note: '4.0 代：支持 1K / 2K / 4K',
  },
]

/** Reference images assumed for an id this adapter cannot place. */
const DEFAULT_MAX_REF_IMAGES = 14

/**
 * Request-body keys `ImageGenerateInput.extra` may passthrough or override.
 * A whitelist rather than a blind spread: the body is sent to a billable
 * endpoint, and an unknown key is far more likely to be a typo than an
 * intentional Ark parameter.
 */
const EXTRA_PASSTHROUGH_KEYS: readonly string[] = [
  'watermark',
  'output_format',
  'sequential_image_generation',
  'sequential_image_generation_options',
  'optimize_prompt_options',
  'background',
  'response_format',
]

/** The generation bounds an Ark image id falls under, when it can be placed. */
function generationFor(model: string): ArkImageGeneration | undefined {
  return IMAGE_GENERATIONS.find((entry) => entry.match.test(model))
}

/**
 * The machine-readable capability of one Ark image id, or `undefined` when this
 * adapter cannot place the generation.
 *
 * This is the adapter's whole answer to "what may this model be asked for": the
 * tiers it accepts, the pixel floor Ark enforces on it, how many references it
 * takes, the ratios the documented pixel table can resolve for it, and a one
 * line hint. Everything downstream — the tool's call-time validation and
 * sibling substitution, the Settings page's per-model display — reads this
 * rather than restating any of it, so a vendor tier change is a one-line edit
 * here and nowhere else.
 * @param model - the model id to describe.
 * @returns the descriptor, or `undefined` for an id this adapter cannot place.
 */
function capabilityFor(model: string): MediaModelCapability | undefined {
  const generation = generationFor(model)
  if (generation === undefined) return undefined
  return {
    id: model,
    label: generation.label,
    tiers: generation.resolutions,
    ...generation.minPixels === undefined ? {} : { minPixels: generation.minPixels },
    maxRefImages: generation.maxRefImages,
    // The ratios this adapter can resolve to an explicit pixel size — the ones
    // its documented table covers. A ratio outside it still reaches Ark as a
    // tier string; this states what the ADAPTER can compute, never a vendor
    // limit it has not verified.
    aspectRatios: Object.keys(PIXELS_BY_RATIO),
    note: generation.note,
  }
}

/**
 * The pixel count a `WIDTHxHEIGHT` size states, or `undefined` for a bare tier
 * string (which Ark resolves itself, so no count exists here to check).
 */
function pixelsOf(size: string): number | undefined {
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (match === null) return undefined
  return Number(match[1]) * Number(match[2])
}

/**
 * Build Ark's `size` field. An explicit `width`/`height` pair wins outright; a
 * resolution tier plus an aspect ratio resolves through Ark's documented pixel
 * table when the model's generation accepts that tier; anything else falls back
 * to the tier string, which Ark resolves itself. Falling back is deliberate for
 * an unplaceable model id: guessing a pixel size for a generation whose tiers
 * are unknown would produce a request Ark rejects.
 * @param input - the provider-neutral generation input.
 * @param model - the model the request will name (its generation sets the tiers).
 * @returns Ark's `size` value: `WxH` or a resolution tier.
 */
function resolveSize(input: ImageGenerateInput, model: string): string {
  if (input.width !== undefined && input.height !== undefined) {
    return `${input.width}x${input.height}`
  }
  const tier = input.resolution ?? DEFAULT_RESOLUTION_TIER
  const ratio = input.aspectRatio
  if (ratio === undefined) return tier
  const generation = generationFor(model)
  if (generation === undefined || !generation.resolutions.includes(tier)) return tier
  return PIXELS_BY_RATIO[ratio]?.[tier] ?? tier
}

/**
 * Sniff the image media type from its magic bytes, defaulting to PNG for an
 * unrecognized payload. Used instead of hard-coding `image/png` so a JPEG/WebP
 * result is persisted with its real type.
 */
function sniffImageMediaType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return 'image/webp'
  }
  return 'image/png'
}

/**
 * The media type stated by Ark's `output_format`, for the degraded URL path
 * where no bytes are available to sniff. An unstated or unrecognized format
 * falls back to PNG, the same default the sniffer uses.
 */
function mediaTypeOfFormat(outputFormat: string | undefined): 'image/png' | 'image/jpeg' | 'image/webp' {
  switch (outputFormat?.toLowerCase()) {
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    default:
      return 'image/png'
  }
}

/** Decode a base64 payload into bytes, accepting a bare string or a data URI. */
function decodeBase64(payload: string): Uint8Array {
  const comma = payload.indexOf(',')
  const raw = comma >= 0 && payload.startsWith('data:') ? payload.slice(comma + 1) : payload
  return new Uint8Array(Buffer.from(raw, 'base64'))
}

/** One entry of Ark's image-generation response. */
interface ArkImageItem {
  url?: string
  b64_json?: string
  size?: string
  output_format?: string
  error?: { code?: string, message?: string } | null
}

/** The image-generation response envelope. */
interface ArkImageResponse {
  data?: ArkImageItem[]
  usage?: unknown
  model?: string
}

/** Provider config; every field is optional with a sensible default. */
export interface ArkImageConfig {
  /** Endpoint base; defaults to {@link ARK_IMAGE_BASE_URL}. */
  baseUrl?: string
  /** Default model id; defaults to {@link DEFAULT_IMAGE_MODEL}. */
  model?: string
  /** Credential reference (environment-variable name); defaults to `ARK_API_KEY`. */
  apiKeyEnv?: string
  /**
   * Settings namespace the roubaai Settings page owns. The key, endpoint, and
   * model a user stores there win over this config; they are read per
   * operation, so editing the page takes effect without reloading the plugin.
   */
  settingsNamespace?: string
}

/**
 * Volcengine Ark image provider (Seedream). Generation is synchronous; the
 * produced image is downloaded and landed through `ctx.attachments.saveImage`,
 * with a URL-only degradation when the download fails — the image already
 * exists at that point, so the job must not fail or regenerate it.
 */
export class ArkImageProvider extends ImageProvider {
  readonly provider = 'ark'
  readonly defaultModel: string

  private readonly baseUrl: string
  private readonly apiKeyEnv: string
  private readonly settingsNamespace: string

  constructor(private readonly ctx: Context, config: ArkImageConfig = {}) {
    super()
    this.baseUrl = config.baseUrl ?? ARK_IMAGE_BASE_URL
    this.defaultModel = config.model ?? DEFAULT_IMAGE_MODEL
    this.apiKeyEnv = config.apiKeyEnv ?? ARK_API_KEY_REF
    this.settingsNamespace = config.settingsNamespace ?? DEFAULT_SETTINGS_NAMESPACE
  }

  /**
   * Resolve the API key per operation. The Settings page wins over the
   * credential store: it is the deployment's explicit per-install choice and
   * the one surface a person can edit without touching the environment. The
   * credential store — and through it `ARK_API_KEY` — stays the fallback, so a
   * deployment that never opens the Settings page is unaffected.
   * @returns the resolved key.
   * @throws {MissingCredentialError} when no source holds a key.
   */
  private async resolveKey(): Promise<string> {
    const key = await this.probeKey('')
    if (key === undefined) throw new MissingCredentialError(this.apiKeyEnv)
    return key
  }

  /**
   * The key a probe should present, or `undefined` when this deployment has
   * none anywhere. `undefined` is not an error here: it is the whole difference
   * between "nothing is configured yet" and "the backend refused what we sent".
   * @param draftKey - a key the configuration form holds but has not saved.
   * @returns the key to present, or `undefined` when nothing is configured.
   */
  private async probeKey(draftKey: string): Promise<string | undefined> {
    return await resolveArkKey(this.ctx, this.settingsNamespace, 'image', this.apiKeyEnv, draftKey)
  }

  /**
   * Endpoint base: the Settings page's override when one is stored, else the
   * deployment-configured base. A trailing slash is trimmed so a pasted URL
   * cannot produce a `//` path segment.
   */
  private resolveBaseUrl(): string {
    const override = readActiveMediaProvider(this.ctx, this.settingsNamespace, 'image').baseUrl
    return (override ?? this.baseUrl).replace(/\/+$/, '')
  }

  /**
   * Default image model: the Settings page's override when one is stored, else
   * the deployment-configured model. It is the fallback for a request that
   * names no model; an explicit `input.model` (the tool's sibling substitution)
   * wins over it, which is why the value is re-read per operation.
   */
  private resolveModel(): string {
    return readActiveMediaProvider(this.ctx, this.settingsNamespace, 'image').model ?? this.defaultModel
  }

  async generate(
    input: ImageGenerateInput,
    signal?: AbortSignal,
    onProgress?: (progress: MediaProgress) => void,
  ): Promise<ImageGenerationResult> {
    const apiKey = await this.resolveKey()
    // Resolved once per generation so the request, the landed attachment, and
    // the reported `providerMeta` can never disagree about the model. An
    // explicit override wins: it is how the tool moves a request to the sibling
    // model that can serve the tier the configured one cannot.
    const model = input.model ?? this.resolveModel()
    const size = resolveSize(input, model)
    this.assertSizeWithinFloor(model, size)
    const payload: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      // A URL result keeps the bytes out of the model context; the image is
      // downloaded and landed here instead.
      response_format: 'url',
      watermark: false,
      // One image per call: the seam's result carries exactly one. The field
      // travels only where the generation accepts it — the pro generation
      // refuses it and fails the request outright.
      ...generationFor(model)?.acceptsSequential === true
        ? { sequential_image_generation: 'disabled' }
        : {},
      size,
    }
    const refImages = input.refImages ?? []
    if (refImages.length === 1) payload['image'] = refImages[0]!
    else if (refImages.length > 1) payload['image'] = [...refImages]
    for (const key of EXTRA_PASSTHROUGH_KEYS) {
      const value = input.extra?.[key]
      if (value !== undefined) payload[key] = value
    }

    let response: { status: number, data: unknown }
    try {
      response = await postJson(`${this.resolveBaseUrl()}/images/generations`, apiKey, payload, signal)
    } catch (error) {
      // A transport failure means no image was requested, so retrying cannot
      // double-bill — but the stage must be named.
      throw isNetworkError(error)
        ? new ArkNetworkError(`Ark image generation ${error.message}`, error)
        : error
    }
    const { status, data } = response
    if (status !== 200) {
      throw new ArkHttpError(await this.submitFailureMessage(status, data, signal), status)
    }
    const item = firstImageItem(data)
    if (item === undefined) {
      throw new ArkHttpError('Ark image generation returned no image', 200)
    }
    // What actually ran, echoed on every result path so the caller can
    // self-correct on its next call. A tier is reported only when the size was
    // resolved FROM a tier: an explicit width×height request did not use one,
    // and naming a tier it never asked for would teach the next call something
    // false. `size` is Ark's own statement about the produced file.
    const runInfo: ImageRunInfo = {
      model,
      ...input.width !== undefined && input.height !== undefined
        ? {}
        : { tier: input.resolution ?? DEFAULT_RESOLUTION_TIER },
      ...typeof item.size === 'string' && item.size.length > 0 ? { size: item.size } : {},
    }
    // The image exists server-side once a URL or inline payload came back.
    // Degrade to a URL reference when the bytes cannot be landed locally —
    // never fail the job or force a regenerate.
    const url = typeof item.url === 'string' && item.url.length > 0 ? item.url : undefined
    if (url === undefined) {
      const inline = typeof item.b64_json === 'string' && item.b64_json.length > 0 ? item.b64_json : undefined
      if (inline === undefined) {
        throw new ArkHttpError('Ark image generation returned an item with no url and no b64_json', 200)
      }
      return await this.land(decodeBase64(inline), model, runInfo)
    }
    let bytes: Uint8Array | undefined
    try {
      bytes = await this.downloadResult(url, signal, onProgress)
    } catch {
      // The image exists at the provider; a URL reference is the honest report.
      return this.urlRef(url, model, item.output_format, runInfo)
    }
    try {
      return await this.land(bytes, model, runInfo, url)
    } catch {
      return this.urlRef(url, model, item.output_format, runInfo)
    }
  }

  /**
   * Refuse a resolved size below the model's documented pixel floor BEFORE the
   * request is submitted. Ark refuses such a size itself ("image size must be
   * at least 3686400 pixels"), but by then the call has been made; the floor is
   * part of the same per-generation table the size was resolved from, so
   * checking it here is exact rather than a guess. A bare tier string — no
   * ratio, or a ratio the table carries no cell for — states no pixel count and
   * is left to Ark to resolve.
   * @param model - the model the request names.
   * @param size - the `size` value about to be sent.
   * @throws {ArkHttpError} when the size is under the model's floor.
   */
  private assertSizeWithinFloor(model: string, size: string): void {
    const generation = generationFor(model)
    const floor = generation?.minPixels
    if (generation === undefined || floor === undefined) return
    const pixels = pixelsOf(size)
    if (pixels === undefined || pixels >= floor) return
    throw new ArkHttpError(
      `Ark image generation refused locally: ${generation.label}（${model}）要求图片至少 `
      + `${floor.toLocaleString('en-US')} 像素，而 ${size} 只有 ${pixels.toLocaleString('en-US')} 像素；`
      + '请提高分辨率档位或改用支持该档位的模型',
      400,
    )
  }

  /**
   * Compose the failure message for a refused submission. Ark's own
   * `error.message` is always included — it is the only authoritative reason —
   * and a refusal naming a model id or endpoint it no longer serves is followed
   * by the ids it does serve, because "the model you configured was retired" is
   * otherwise indistinguishable from a bad key or a broken endpoint.
   * @param status - the HTTP status Ark answered.
   * @param data - the parsed error body.
   * @param signal - cancellation forwarded to the model-list request.
   * @returns the one-line message, a failed model lookup included as a hint.
   */
  private async submitFailureMessage(status: number, data: unknown, signal?: AbortSignal): Promise<string> {
    const detail = arkErrorDetail(data)
    const code = detail.code === undefined ? '' : `（${detail.code}）`
    // A 404 here never means "no such task": the request was refused before any
    // image existed. Ark's own words are the diagnosis and its catalogue is the
    // way out, so the generic status wording is deliberately skipped.
    if (isModelNotFound(status, detail)) {
      const reason = detail.message ?? '模型或接入点不存在（方舟未说明原因）'
      const available = await this.availableModelHint(signal)
      return `Ark image generation failed [${status}]${code} ${reason}；${available}`
    }
    const reason = detail.message === undefined
      ? arkStatusMeaning(status)
      : `${arkStatusMeaning(status)}：${detail.message}`
    return `Ark image generation failed [${status}]${code} ${reason}`
  }

  /**
   * The available-model hint appended to a model-not-found failure. Every
   * failure on this path is swallowed: the model list is a courtesy, and a
   * lookup that fails must never replace the real refusal.
   * @param signal - cancellation forwarded to the model-list request.
   * @returns a `可用模型：…` line, or why the list could not be read.
   */
  private async availableModelHint(signal?: AbortSignal): Promise<string> {
    try {
      const models = await this.listModels(signal)
      const ids = formatModelIds(models)
      return ids === '' ? '可用模型：方舟未返回任何 seedream 图像模型' : `可用模型：${ids}`
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return `可用模型列表获取失败：${reason}`
    }
  }

  /** Download a generated image, reporting download progress. */
  private async downloadResult(
    url: string,
    signal?: AbortSignal,
    onProgress?: (progress: MediaProgress) => void,
  ): Promise<Uint8Array> {
    onProgress?.({ phase: 'downloading', percent: 0 })
    const bytes = await downloadBytes(url, signal, {
      // Cap the result so a huge or malicious CDN payload cannot be buffered in
      // full; Ark image results are at most a few MB.
      maxBytes: MAX_IMAGE_BYTES,
      onProgress: (received, total) => {
        onProgress?.({
          phase: 'downloading',
          percent: total !== undefined && total > 0 ? Math.round((received / total) * 100) : 0,
        })
      },
    })
    onProgress?.({ phase: 'saving', percent: 100 })
    return bytes
  }

  /**
   * Degrade a generated-but-not-landed image to a URL-only reference. The model
   * and the run echo are passed in (never re-resolved) so the reported
   * `providerMeta` and `run` name the model and tier this generation actually
   * used.
   */
  private urlRef(
    url: string,
    model: string,
    outputFormat: string | undefined,
    run: ImageRunInfo,
  ): ImageGenerationResult {
    const mediaType = mediaTypeOfFormat(outputFormat)
    return {
      kind: 'image',
      mediaType,
      mediaRef: {
        url,
        mediaType,
        expiresAt: Date.now() + MEDIA_URL_TTL_MS,
      },
      run,
      providerMeta: { provider: this.provider, model },
    }
  }

  /** Persist image bytes and return the unified result reference. */
  private async land(
    bytes: Uint8Array,
    model: string,
    run: ImageRunInfo,
    resultUrl?: string,
  ): Promise<ImageGenerationResult> {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      throw new Error('media-ark: ctx.attachments is missing; cannot persist the generated image')
    }
    const mediaType = sniffImageMediaType(bytes)
    const extension = mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png'
    const ref = await attachments.saveImage({
      data: bytes,
      mediaType,
      name: `generated.${extension}`,
    })
    return {
      kind: 'image',
      attachmentRef: ref.attachmentId,
      attachment: ref,
      // Use the sniffed type (no gif) rather than the attachment's mediaType,
      // which `saveImage` may widen to include `image/gif`.
      mediaType,
      // Keep Ark's 24h result URL on the landed path too: the completion
      // message surfaces it so `media_asset_save` can fetch it as a fallback
      // when the attachment reference cannot be resolved.
      ...resultUrl !== undefined ? { resultUrl } : {},
      run,
      providerMeta: {
        provider: this.provider,
        model,
      },
    }
  }

  /**
   * What one Seedream model accepts, straight out of the same per-generation
   * table the request builder reads — one source for the tiers a request may
   * name, the pixel floor Ark enforces, and the reference bound. The tool
   * validates against it at call time; the Settings page renders it.
   * @param model - the model to describe; omitted describes the model this
   * provider is currently configured to run (its Settings-page row, else its
   * own default).
   * @returns the descriptor, or `undefined` for an id this adapter cannot place
   * (the tool then passes the request through untouched).
   */
  override capabilities(model?: string): MediaModelCapability | undefined {
    return capabilityFor(model ?? this.resolveModel())
  }

  /** Reference images the model's generation accepts on one image request. */
  caps(model?: string): ImageCaps {
    const resolved = model ?? this.resolveModel()
    return { maxRefImages: generationFor(resolved)?.maxRefImages ?? DEFAULT_MAX_REF_IMAGES }
  }

  /**
   * Ark bills in RMB, so this adapter states no USD figure; the ledger records
   * the run unpriced instead of converting at a rate it does not own.
   * @returns always `undefined`.
   */
  estimateCostUsd(): number | undefined {
    return undefined
  }

  /**
   * List the Seedream image models this deployment may request. Ark reports the
   * capability per model as `task_type`, so the catalogue is filtered on it
   * rather than on a naming guess alone.
   * @param signal - cancellation forwarded to the model-list request.
   * @returns the image models Ark reports, in Ark's order.
   * @throws {ArkHttpError} when Ark answers a non-200.
   */
  override async listModels(signal?: AbortSignal): Promise<MediaModelInfo[]> {
    const apiKey = await this.resolveKey()
    return await fetchArkModels(this.resolveBaseUrl(), apiKey, { taskType: 'Image', idIncludes: 'seedream' }, signal)
  }

  /**
   * List the image models for the endpoint and key a configuration form holds,
   * so a key that has not been saved yet can still browse the catalogue. An
   * empty draft field falls back to the configured value, exactly as
   * {@link probe} does.
   * @param draft - the endpoint and key the form holds.
   * @param signal - cancellation forwarded to the model-list request.
   * @returns the image models Ark reports, in Ark's order.
   */
  override async listModelsWithDraft(draft: ProviderProbeDraft, signal?: AbortSignal): Promise<MediaModelInfo[]> {
    const base = draft.baseUrl.trim() === ''
      ? this.resolveBaseUrl()
      : draft.baseUrl.trim().replace(/\/+$/, '')
    const apiKey = draft.apiKey.trim() === '' ? await this.resolveKey() : draft.apiKey.trim()
    return await fetchArkModels(base, apiKey, { taskType: 'Image', idIncludes: 'seedream' }, signal)
  }

  /**
   * Probe the endpoint and key the configuration form holds. A model-list read:
   * HTTP 200 proves both reachability and key acceptance without generating
   * anything, and a refusal carries Ark's own status and `error.message` so the
   * form can show what Ark actually said.
   *
   * A row with no key anywhere is reported as `unconfigured`, not as a failure:
   * nothing was probed, and painting that red would hide the difference between
   * "fill this in" and "what you filled in is wrong".
   */
  async probe(draft: ProviderProbeDraft): Promise<ProviderProbeResult> {
    const base = draft.baseUrl.trim() === ''
      ? this.resolveBaseUrl()
      : draft.baseUrl.trim().replace(/\/+$/, '')
    if (base === '') return { status: 'failed', message: '表单未填写接口地址，且该后端也未配置默认端点' }
    const apiKey = await this.probeKey(draft.apiKey)
    if (apiKey === undefined) {
      return { status: 'unconfigured', message: arkUnconfiguredReason(this.apiKeyEnv) }
    }
    try {
      const { status, data } = await getJson(`${base}/models`, apiKey)
      if (status === 200) return { status: 'ok', message: '连接成功（HTTP 200）' }
      const detail = arkErrorDetail(data)
      const code = detail.code === undefined ? '' : `（${detail.code}）`
      const reason = detail.message ?? arkStatusMeaning(status)
      return { status: 'failed', message: `端点返回 HTTP ${status}${code}：${reason}` }
    } catch (error) {
      return { status: 'failed', message: `无法连接端点：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const apiKey = await this.resolveKey()
      // A read-only model-list call: 200 proves the key authenticated and the
      // service answered, without spending a generation.
      const { status } = await getJson(`${this.resolveBaseUrl()}/models`, apiKey)
      return status === 200
    } catch {
      return false
    }
  }
}

/**
 * The first usable entry of an image response: one carrying a URL or inline
 * payload. An entry that only reports its own error is skipped unless no entry
 * produced an image, in which case its reason is the most useful thing to say.
 */
function firstImageItem(data: unknown): ArkImageItem | undefined {
  const response = data as ArkImageResponse | null
  const items = Array.isArray(response?.data) ? response.data : []
  const usable = items.find((item) =>
    (typeof item.url === 'string' && item.url.length > 0)
    || (typeof item.b64_json === 'string' && item.b64_json.length > 0))
  if (usable !== undefined) return usable
  const failed = items.find((item) => typeof item.error?.message === 'string' && item.error.message.length > 0)
  if (failed !== undefined) {
    throw new ArkHttpError(`Ark image generation returned an error item: ${failed.error?.message ?? ''}`, 200)
  }
  return undefined
}
