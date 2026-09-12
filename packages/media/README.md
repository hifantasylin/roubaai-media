---
description: "The media generation capability seam: a ctx.media provider registry plus the generate_image, generate_video, generate_music, and asset tools, and how to mount providers beside it."
kind: "package-bundle"
---

# @roubaai/media

English | [中文](README.zh.md)

## Summary

`dsh-media` gives a dsh agent the ability to generate and manage media through interchangeable providers. It mounts the `ctx.media` registry, the `ctx.mediaUrl` local-reference normalizer, and seven model-facing tools — `generate_image`, `generate_video`, `generate_music`, `media_asset_save`, `media_reference_url`, `media_extract_frame`, and `media_cost_summary` — that stay provider-agnostic. Provider bundles such as `dsh-media-maizi` and `dsh-media-mxapi` register image, video, and music backends onto the same registry; registering a provider is all it takes to wire it to the tools. Generation runs as background jobs so calls never block on minute-long provider work, results arrive through the session's `job_output`, and wanted media is persisted into the workspace asset library before provider URLs expire. Choose this package when a composition should let the model produce or reference image, video, or music assets and keep a per-workspace cost record of it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the media row together with the provider rows you want; the base composition supplies the `tools`, `jobs`, and `attachments` services the tools run against. In this repository the media rows ship in the base patch and, for web sessions, in the standard agent preset's media realm; an out-of-tree composition mounts the same rows explicitly.

```yaml
- name: '@roubaai/media'
- name: '@roubaai/media-maizi'
- name: '@roubaai/media-mxapi'
```

The media row takes no configuration; each provider row configures its own endpoint and credential reference. Providers resolve credentials per operation through `ctx.credentials`, so the default environment names (`MAIZI_API_KEY`, `MXAPI_API_KEY`) can be overridden without editing the mount.

### What the tools do

| Tool | Behavior |
|---|---|
| `generate_image` / `generate_video` / `generate_music` | Start a background generation job and return its id; results carry a provider task handle and a 24-hour media URL |
| `media_asset_save` | Persist a generated or uploaded asset into `<cwd>/.assets/<category>/<name>.<ext>` and update the asset index |
| `media_reference_url` | Re-publish a local or host-local reference as a fresh public URL for a later provider call |
| `media_extract_frame` | Pull one frame from a video file |
| `media_cost_summary` | Fold the workspace media cost ledger into an owner-readable summary |

Each generation job appends one line to the workspace cost ledger (`<cwd>/.assets/<project>/media-cost.jsonl`): provider-reported for video and music, a rate-table estimate for images. The ledger's project and label arguments come from the model call and drive retry detection.

### Provider selection

A tool call with no provider name uses the first registered backend of the kind it needs; `NO_PROVIDER` is a final deny surfaced by the tool guard when none is registered. Mounting or removing a provider bundle therefore changes which backend the tools resolve without touching the seam or its tools.

### Model capability and tiers: which to pick

What a model accepts is stated by the **provider itself** (`capabilities(model)`): the resolution tiers, the pixel floor, the reference-image bound, the aspect ratios. `generate_image`'s `resolution` parameter therefore carries **no enum** — models differ, so a written list would drift from the backend that owns the fact; the call-time check, the default tier, and the move to a model that can serve the request are all derived from that capability.

| What you want | What to pick |
|---|---|
| Lightweight composition drafts, fast iteration | lite class + 2K |
| The 1.5K middle tier | pro class + 1.5K |
| Large, detailed output | lite class + 3K / 4K |
| Precise edits / many references / layer splitting | pro class |

Ids carry a date segment and retire, so this table names tier CLASSES (lite / pro), not one id. The default tier is 2K. When a call asks for a tier the configured model does not have but a sibling in the catalogue does, the tool moves that request to the sibling and says so in the job result; when no model can serve it, the call fails naming that model's tiers, its pixel floor, and its siblings' tiers. A backend that reports no capability (Maizi, mxapi) is untouched: no validation, no substitution, no defaulted tier.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the seam; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The package mirrors the harness's "abstract service plus adapter registration" layering: `ctx.media` is a provider registry whose providers register themselves and can be withdrawn, and the tools stay provider-agnostic. Everything model-facing — tool schemas, descriptions, background-job lifecycle, and the cost ledger — lives here, so providers implement only a narrow execution contract and never render to the model.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: registration of services and tools |
| [`src/service.ts`](src/service.ts) | The `ctx.media` service definition |
| [`src/media-local.ts`](src/media-local.ts) | The process-local `MediaRuntimeLocal` registry implementation |
| [`src/provider.ts`](src/provider.ts) | Image/video/music provider contracts, the per-model capability descriptor, and shared result types |
| [`src/tunnel.ts`](src/tunnel.ts) | The `ctx.mediaUrl` local-reference normalizer (static server plus tunnel) |
| [`src/tools/`](src/tools/) | The seven model-facing tool executors |
| [`src/cost-ledger.ts`](src/cost-ledger.ts) | The per-workspace media cost ledger and summary fold |

### Service and tool registration

`new MediaRuntimeLocal(ctx)` registers `ctx.media` for the apply fiber, and `new MediaUrlNormalizer(ctx)` registers `ctx.mediaUrl`; both are withdrawn when the row unloads. Tools register into the `tools` registry with `defineTool`, start background work through `ctx.jobs`, and persist results through `ctx.attachments`. In a per-session preset realm the registry and its providers share that realm so each session sees its own mounted set; on a host-plane row they share the process instance instead.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [dsh-media-maizi](../media-maizi/README.md) — the MaiziAI image and video provider bundle.
- [dsh-media-mxapi](../media-mxapi/README.md) — the MxAPI music provider bundle.

-----

<a id="model-experience"></a>
## Model Experience

### Media generation tools

#### What the model sees

The `generate_image`, `generate_video`, and `generate_music` tools register once a provider mounts onto `ctx.media`; each call starts a background job through `ctx.jobs` and returns a `kind: background` envelope with a `jobId`, because generation takes tens of seconds to minutes. Tool descriptions name the provider default model and the billing-sensitive options (resolution, reference-image count, audio, frame extraction), and the deny guard answers `no image provider is configured`-style refusals when no backend of the needed kind is registered.

`generate_image`'s `resolution` description deliberately lists no tiers and points at the serving adapter's capability instead: tiers differ per model, and a written list is exactly what produced the invalid call this seam exists to prevent. A finished job's `run` field reports the model, tier, and the pixel size the vendor returned (`run.model` / `run.tier` / `run.size`), plus `run.requestedModel` and `run.switchNote` when the request moved to a sibling model, so the next call can correct itself.

#### Token effect

The three tool schemas are fixed request overhead while they are in the tool view; a completed job's result text is retained in the session until compaction.

#### KV Cache effect

Prefix-stable while the visible tool definitions and order are unchanged; provider configuration does not alter the request prefix.

### Generation results and assets

#### What the model sees

A finished job reports through the session's `job_output` with a provider task handle and a 24-hour media URL. The model persists what it wants to keep with `media_asset_save` into `<cwd>/.assets/<category>/<name>.<ext>` (with an `assets-index.md`), re-publishes local or host-local paths as fresh public URLs for later provider calls with `media_reference_url`, and pulls video frames with `media_extract_frame`.

#### Token effect

Result and asset text is retained until compaction; each extra output (audio, last frame, an extracted frame) adds its own result text and cost.

#### KV Cache effect

Append-only for ordinary results; newly visible content follows the reusable request prefix and does not invalidate existing cache entries.

### Media cost ledger

#### What the model sees

Every completed generation writes one line to `<cwd>/.assets/<project>/media-cost.jsonl` — provider-reported for video and music, a rate-table estimate for images — and the `media_cost_summary` tool folds the ledger into an owner-readable total with per-project and per-label breakdowns and a retry marker for repeated labels.

#### Token effect

Only a call to `media_cost_summary` adds the folded summary text to history.

#### KV Cache effect

Prefix-stable; ledger growth is not part of the request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the media capability is a poor fit or needs special operational care. They are current package constraints.

- **Generation is provider- and key-gated** — the tools need at least one provider of the needed kind mounted and its credential resolvable; absent either, calls fail with `NO_PROVIDER` or a missing-credential error.
- **Provider URLs expire** — generation results carry a roughly 24-hour URL, so wanted media must be persisted with `media_asset_save` before the window closes.
- **Local references need a public URL** — `media_reference_url` turns local and host-local paths into public URLs through a local static server and a tunnel; a deployment without a reachable tunnel binary has no path for local-reference media.
- **The cost ledger is workspace-scoped and rouba-flavored** — ledger files live under `<cwd>/.assets/`, directory names come from the model-supplied `project` label (defaulting to the workspace), and the tool descriptions carry production-workflow vocabulary.
- **No inline media delivery** — every generate tool is a background job whose output is a job id; media reaches the model only as text URLs or persisted files, never as an inline result block.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
