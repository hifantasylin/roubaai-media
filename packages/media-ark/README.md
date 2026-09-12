---
description: "The Volcengine Ark video backend for the ctx.media seam: calls Ark's own asynchronous generation task API with a deployment's Ark API key."
kind: "package-bundle"
---

# @roubaai/media-ark

English | [中文](README.zh.md)

## Summary

`@roubaai/media-ark` supplies the Volcengine Ark (火山方舟) backend for video generation. Mounted beside `@roubaai/media`, it registers one video provider on `ctx.media`, which is all `generate_video` needs to route a call to Ark. It talks to Ark's own task API — `POST /contents/generations/tasks`, polled through `GET /contents/generations/tasks/{id}` — with the deployment's `ARK_API_KEY`, so a deployment can run Ark without routing through an aggregator.

A provider row on the Settings page selects this backend by naming `ark` as its adapter. Without that selection the provider is mounted but unused: `generate_video` routes to whichever adapter the active row names, and an unconfigured deployment resolves to the registry default.

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

Then add or edit a video provider row on the Settings page: set its **adapter** to `ark`, its endpoint to `https://ark.cn-beijing.volces.com/api/v3` (or leave the row's endpoint empty to use that default), and paste an Ark API key. Select the row to make it the one `generate_video` uses.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://ark.cn-beijing.volces.com/api/v3` | Endpoint base override |
| `videoModel` | `doubao-seedance-1-5-pro-251215` | Default model id; every call names one explicitly |
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
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema and provider registration |
| [`src/ark-video-provider.ts`](src/ark-video-provider.ts) | The `ArkVideoProvider`: task submission, polling, caps, and result probing |
| [`src/http.ts`](src/http.ts) | JSON calls and the read-only result probe, with transient-failure retries |

### Request mapping

Ark takes a multimodal `content` array rather than a flat prompt plus image list, so the seam's provider-neutral input maps onto typed entries:

| Seam input | Ark `content` entry |
|---|---|
| `prompt` | `{ type: 'text', text }` |
| `imageUrls` (one) | `{ type: 'image_url', image_url: { url }, role: 'first_frame' }` |
| `imageUrls` (several) | one `image_url` entry per URL, `role: 'reference_image'` |
| `imageWithRoles` | one `image_url` entry per entry, its `role` passed through verbatim |
| `videoUrls` | `{ type: 'video_url', video_url: { url }, role: 'reference_video' }` |
| `audioUrls` | `{ type: 'audio_url', audio_url: { url }, role: 'reference_audio' }` |

`size` becomes Ark's `ratio`, and `generationType: 'video_edit'` becomes `omni_reference_task_type: 'edit'`. A caller that means first-plus-last frame, or a mixture of frames and reference images, says so through `imageWithRoles`: the one-image and several-image rules above are a default, not a guess about intent.

Ark's status vocabulary normalizes as `succeeded` → succeeded, `failed` and `expired` → failed, and `queued` / `running` → running. A deterministic 4xx while polling fails the task immediately with the status rendered in Chinese, so a bad key or a denied model surfaces as itself rather than as a polling timeout.

### Caps and pricing

`caps(model)` matches the model-generation fragment of the id (`seedance-2-5`, `seedance-2-0`, `seedance-1-5`); an id matching none takes the most conservative set Ark accepts, which rejects an oversized request before it is billed. `estimateCostUsd` returns `undefined` — see the limitations below.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-media](../media/README.md) — the `ctx.media` seam, the `generate_video` tool, and the adapter selection this backend plugs into.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `generate_video` in `dsh-media`, which owns the model-facing schema, description, and result envelope; this backend only executes the generation and reports Ark's state.

#### KV Cache effect

No direct invalidation; the media tool rows own any request-prefix changes.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Video only.** Ark also serves image models; this package registers no image provider, so `generate_image` cannot route to Ark.
- **No USD cost estimate.** Ark prices in RMB per second with time-boxed discounts, so `estimateCostUsd` returns `undefined` and the cost ledger records an Ark run unpriced rather than converting at a rate this package does not own. Converting needs a rate the deployment configures.
- **The model id is not validated.** Ark model ids carry a dated suffix and change with each release, so the provider accepts any id and lets Ark reject an unknown one. `caps()` falls back to the conservative set for an id it cannot place.
- **The result URL's lifetime is assumed.** Ark states no expiry for the produced file, so the provider stamps the 24h policy the other adapters use. Persist wanted assets with `media_asset_save` before it lapses.
- **Task ids expire after 7 days.** Ark discards a task id seven days after creation; a poll after that answers 404 and the job reports it as a failed task.
