---
description: "The MaiziAI image and video generation backend for ctx.media: mounting it registers image and video providers the generate_image and generate_video tools call."
kind: "package-bundle"
---

# @roubaai/media-maizi

English | [中文](README.zh.md)

## Summary

`dsh-media-maizi` supplies the MaiziAI backend for the media generation capability. Mounted beside `dsh-media`, it registers an image provider and a video provider onto `ctx.media`, which is all the `generate_image` and `generate_video` tools need to route calls to Maizi. Image generation runs against Maizi's synchronous endpoint and video against its asynchronous v1 task API; both resolve the `MAIZI_API_KEY` credential per operation through `ctx.credentials`. Choose this bundle when a deployment generates images and videos through Maizi; a provider that is not mounted is simply absent from the media registry, so adding or removing it changes only which backend the tools resolve.

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

Mount the provider bundle next to the media seam in any composition that runs the generation tools. This package ships its own profile-layer patch, so it also installs with `dsh plugin --profile <name> add @roubaai/media-maizi`; either way the mounted row is the same `media-maizi` plugin.

```yaml
- name: '@roubaai/media'
- name: '@roubaai/media-maizi'
```

The provider resolves its key from the credential store: the default reference is the `MAIZI_API_KEY` environment variable, and `apiKeyEnv` overrides that name. A missing key surfaces as a provider-side missing-credential error at generation time, not at mount.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | Maizi public API | Endpoint base override |
| `imageModel` | provider default | Default image model id |
| `videoModel` | provider default | Default video model id |
| `apiKeyEnv` | `MAIZI_API_KEY` | Credential reference (environment-variable name) |
| `pollTimeoutMs` | `60000` | Foreground image poll ceiling in milliseconds |

Every field is optional; the defaults above are the shipped behavior. A field set through the mounted row's `config` overrides the default for that row.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider bundle; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The bundle is thin on purpose: it implements the two provider contracts from `dsh-media` (`ImageProvider` and `VideoProvider`) and registers them with `ctx.media.registerImageProvider` and `registerVideoProvider`. The tool schemas, background-job lifecycle, and cost ledger all live in the seam package, so the provider stays replaceable and the model-facing surface unchanged.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema and provider registration |
| [`src/maizi-image-provider.ts`](src/maizi-image-provider.ts) | The `MaiziImageProvider`: synchronous v2 image generation with a foreground poll ceiling |
| [`src/maizi-video-provider.ts`](src/maizi-video-provider.ts) | The `MaiziVideoProvider`: asynchronous v1 video task submission and polling |

### Key resolution

Each generation resolves `MAIZI_API_KEY` (or the configured `apiKeyEnv` name) through `ctx.credentials` at operation time, never at mount. That keeps key rotation live and keeps the plugin from failing to load when a key is not yet configured.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [dsh-media](../media/README.md) — the `ctx.media` seam and the `generate_image`/`generate_video` tools this provider feeds.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `generate_image` and `generate_video` tools in `dsh-media`, which own the model-facing schemas, descriptions, and result envelopes; this backend only executes generation and reports provider state.

#### KV Cache effect

No direct invalidation; the media tool rows own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the Maizi backend is a poor fit or needs special operational care. They are current package constraints.

- **Requires the media seam and a mounted companion** — without a `dsh-media` row the provider never registers, and without the seam's tool rows there is nothing to call it.
- **Keyed per operation** — generation fails with a missing-credential error when `MAIZI_API_KEY` (or `apiKeyEnv`) is absent or revoked; the error surfaces at call time, not at mount.
- **Provider URLs expire** — Maizi result URLs are time-limited, so wanted media must be persisted with `media_asset_save` before they expire.
- **Default models are Maizi's** — the effective model follows Maizi's service defaults unless `imageModel` or `videoModel` is set.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
