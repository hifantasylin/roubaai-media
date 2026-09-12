---
description: "The Volcengine Ark backend for the ctx.media seam: image (Seedream) and video (Seedance) generation through Ark's own APIs with a deployment's Ark API key, plus a live read of the models a deployment may request."
kind: "package-bundle"
---

# @roubaai/media-ark

English | [中文](README.zh.md)

## Summary

`@roubaai/media-ark` supplies the Volcengine Ark (火山方舟) backend for image and video generation. Mounted beside `@roubaai/media`, it registers one image provider and one video provider on `ctx.media`, which is all `generate_image` and `generate_video` need to route a call to Ark. It talks to Ark's own APIs — `POST /images/generations` for Seedream images, and `POST /contents/generations/tasks` polled through `GET /contents/generations/tasks/{id}` for Seedance video — with the deployment's `ARK_API_KEY`, so a deployment can run Ark without routing through an aggregator.

It is the shipped default for both categories: an unconfigured deployment resolves image and video to `ark` (music stays on `mxapi`). A provider row on the Settings page selects this backend by naming `ark` as its adapter; without a row the provider is still what an unconfigured category runs.

Ark model ids embed a release or date segment (`doubao-seedream-5-0-pro-260628`, `doubao-seedance-2-0-260128`) and Ark retires them on its own schedule, so this package never treats a configured id as a promise. Both providers implement `listModels()`, which reads `GET {base}/models` and reports what the deployment may actually request right now.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider bundle next to the media seam. This package ships its own profile-layer patch, so it installs with `dsh plugin --profile <name> add @roubaai/media-ark`; either way the mounted row is the same `media-ark` plugin.

```yaml
- name: '@roubaai/media'
- name: '@roubaai/media-ark'
```

Then add or edit a provider row on the Settings page: set its **adapter** to `ark`, its endpoint to `https://ark.cn-beijing.volces.com/api/v3` (or leave the row's endpoint empty to use that default), and paste an Ark API key. Select the row to make it the one the tools use. The model field offers the ids Ark currently serves — see [Model catalogue](#model-catalogue) — and keeps a free-text fallback.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://ark.cn-beijing.volces.com/api/v3` | Endpoint base override |
| `imageModel` | `doubao-seedream-5-0-260128` | Default image model id (the plain, lite-class Seedream 5.0) |
| `videoModel` | `doubao-seedance-2-0-mini-260615` | Default video model id; every video call may name one explicitly |
| `apiKeyEnv` | `ARK_API_KEY` | Credential reference (environment-variable name) |
| `settingsNamespace` | `roubaai-video-plugin` | Settings namespace the provider reads the active row from |

Every field is optional; the defaults above are the shipped behavior. A field set through the mounted row's `config` overrides the default for that row. A key stored on the Settings page wins over the credential store, so a deployment that never opens the page keeps working from `ARK_API_KEY` alone.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema and both provider registrations |
| [`src/ark-image-provider.ts`](src/ark-image-provider.ts) | The `ArkImageProvider`: Seedream submission, size mapping, caps, result landing, and the model catalogue |
| [`src/ark-video-provider.ts`](src/ark-video-provider.ts) | The `ArkVideoProvider`: task submission, polling, caps, result probing, and the model catalogue |
| [`src/ark-models.ts`](src/ark-models.ts) | `GET /models` parsing and filtering, shared by both providers |
| [`src/http.ts`](src/http.ts) | JSON calls, the read-only result probe, byte downloads, and Ark's error envelope |
| [`src/errors.ts`](src/errors.ts) | The missing-credential error both providers raise |

### Request mapping

Ark takes a multimodal `content` array rather than a flat prompt plus image list, so the seam's provider-neutral video input maps onto typed entries:

| Seam input | Ark `content` entry |
|---|---|
| `prompt` | `{ type: 'text', text }` |
| `imageUrls` (one) | `{ type: 'image_url', image_url: { url }, role: 'first_frame' }` |
| `imageUrls` (several) | one `image_url` entry per URL, `role: 'reference_image'` |
| `imageWithRoles` | one `image_url` entry per entry, its `role` passed through verbatim |
| `videoUrls` | `{ type: 'video_url', video_url: { url }, role: 'reference_video' }` |
| `audioUrls` | `{ type: 'audio_url', audio_url: { url }, role: 'reference_audio' }` |

`size` becomes Ark's `ratio`, and `generationType: 'video_edit'` becomes `omni_reference_task_type: 'edit'`. A caller that means first-plus-last frame, or a mixture of frames and reference images, says so through `imageWithRoles`: the one-image and several-image rules above are a default, not a guess about intent.

An image request is a flat body instead: `model`, `prompt`, `response_format: 'url'`, `watermark: false`, `sequential_image_generation: 'disabled'`, and `size`. `refImages` becomes Ark's `image` — one reference as a bare string, several as an array — and `extra` may passthrough or override the documented Ark image fields (`watermark`, `output_format`, `sequential_image_generation`, `sequential_image_generation_options`, `optimize_prompt_options`, `background`, `response_format`). Anything else in `extra` is ignored rather than forwarded to a billable endpoint.

`size` is resolved in three steps: an explicit `width`/`height` pair is used as given; otherwise a resolution tier plus an aspect ratio is looked up in Ark's documented pixel table for a tier the model's generation accepts; otherwise the tier string itself is sent and Ark resolves it. The fallback is deliberate for a model id whose generation cannot be placed — guessing a pixel size for unknown tiers produces a request Ark rejects. Ark documents which tiers each generation accepts (Seedream 5.0 pro 1K/1.5K/2K; the plain 5.0 / lite class 2K/3K/4K; 4.5 2K/4K; 4.0 1K/2K/4K), which is also what `caps()` reports reference-image limits from (10 for 5.0 pro, 14 otherwise).

The plain, non-`pro` 5.0 id (`doubao-seedream-5-0-260128`) is the lite class, and Ark enforces a **3,686,400-pixel floor** on it: `size=1536x1536` is refused, and `size=1.5K` is not even a legal value. A request whose resolved size falls under that floor is refused here — before it reaches a billable endpoint — with the floor and the actual pixel count in the message.

`capabilities(model)` states all of this as one machine-readable descriptor per model (tiers, pixel floor, reference bound, the ratios the pixel table can resolve, a short hint). It is the single source the `generate_image` tool validates against and the Settings page renders, so a vendor tier change is a one-line edit to `IMAGE_GENERATIONS` and nothing else. An id this adapter cannot place answers `undefined`, and the tool then passes the request through untouched.

Generation results echo what ran: `providerMeta.model` names the model (an explicit `input.model` override wins over the configured default, which is how the tool moves a request to a sibling model), and `run` carries the model, the tier, and the pixel size Ark reported for the produced image.

Ark's video status vocabulary normalizes as `succeeded` → succeeded, `failed` and `expired` → failed, and `queued` / `running` → running. A deterministic 4xx while polling fails the task immediately with the status rendered in Chinese, so a bad key or a denied model surfaces as itself rather than as a polling timeout.

<a id="model-catalogue"></a>
### Model catalogue

Ark's model ids carry a date segment and retire, so both providers implement the seam's optional catalogue capability:

```ts
provider.listModels?.(signal)                 // → MediaModelInfo[] ({ id, status?, taskTypes? })
provider.listModelsWithDraft?.(draft, signal) // the same, against a form's unsaved endpoint and key
```

`listModels()` reads `GET {base}/models` and filters on what Ark reports: `task_type` containing `Video` for the video provider, containing `Image` with a `seedream` id for the image provider. `listModelsWithDraft` exists so the Settings page can browse the catalogue — and validate a key — before anything is saved; an empty draft field means "use the configured value". The Settings page exposes both through the `models.list` route on `@roubaai/settings`.

A submission refused for a model Ark no longer serves is reported as such, not as a missing task: the provider names Ark's own error code and message, then appends the ids Ark does serve, e.g.

```
Ark video submission failed [404]（InvalidEndpointOrModel.NotFound）The model or endpoint does not exist；可用模型：doubao-seedance-2-0-mini-260615、doubao-seedance-2-0-260128
```

If the catalogue cannot be read either, that failure is reported in the same line rather than replacing Ark's message.

### Probing a row

`probe(draft)` answers one of three states, because "nobody has filled this in yet" and "Ark refused what was sent" are different things to show a person:

| State | When | What the page shows |
|---|---|---|
| `ok` | `GET {base}/models` answered 200 | green |
| `unconfigured` | no key anywhere: the draft is empty, nothing is stored for the row, and `ARK_API_KEY` resolves to nothing | neutral — nothing was probed, so nothing failed |
| `failed` | a key exists and Ark refused it | red, carrying the HTTP status and Ark's own `error.message` |

The key sources are consulted in that order — form draft, stored row, credential store / environment — so a key can be validated in the same breath it is typed, and a deployment that only ever set `ARK_API_KEY` still probes. `probe` is read-only: it reads the model list, never generates.

### Caps and pricing

`caps(model)` matches the model-generation fragment of the id (`seedance-2-5`, `seedance-2-0`, `seedance-1-5`; `seedream-5-0-pro`, `seedream-5-0-lite`, the plain `seedream-5-0`, `seedream-4-5`, `seedream-4-0`); an id matching none takes the most conservative set, which rejects an oversized request before it is billed. Every pattern requires a non-digit before the version digit, so a release date (`…-4-0-250828`, which contains `50`) is never read as a version. `capabilities(model)` reports the same table in the seam's machine-readable form. `estimateCostUsd` returns `undefined` — see the limitations below.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-media](../media/README.md) — the `ctx.media` seam, the `generate_image` / `generate_video` tools, and the adapter selection this backend plugs into.
- [dsh-settings](../settings/README.md) — the Settings page, its `models.list` route, and the model picker that reads this catalogue.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `generate_image` / `generate_video` in `dsh-media`, which own the model-facing schema, description, and result envelope; this backend only executes the generation and reports Ark's state. The model catalogue is reachable only through the Settings page route, never as a tool.

#### KV Cache effect

No direct invalidation; the media tool rows own any request-prefix changes.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No USD cost estimate.** Ark prices in RMB with time-boxed discounts, so `estimateCostUsd` returns `undefined` and the cost ledger records an Ark run unpriced rather than converting at a rate this package does not own. Converting needs a rate the deployment configures.
- **The model id is not validated locally.** The provider accepts any id and lets Ark reject an unknown one; its refusal carries the current catalogue so the next attempt can pick a live id. Nothing pre-validates a stored id between calls — `listModels()` is the way to check.
- **Result-URL lifetime is assumed.** Ark states no expiry for the produced file, so both providers stamp the 24h policy the other adapters use. Persist wanted assets with `media_asset_save` before it lapses.
- **Task ids expire after 7 days.** Ark discards a task id seven days after creation; a poll after that answers 404 and the job reports it as a failed task.
- **The image `size` table is Ark's documented one.** A generation whose tiers this package cannot place gets the resolution tier string instead of a pixel size; adding a generation means adding its row to `IMAGE_GENERATIONS` and its tiers to `PIXELS_BY_RATIO`.
