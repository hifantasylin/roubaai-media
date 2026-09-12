---
description: "The MxAPI music generation backend for ctx.media: mounting it registers the music provider the generate_music tool calls for Suno-style BGM or song generation."
kind: "package-bundle"
---

# @roubaai/media-mxapi

English | [中文](README.zh.md)

## Summary

`dsh-media-mxapi` supplies the MxAPI music backend for the media generation capability. Mounted beside `dsh-media`, it registers a music provider onto `ctx.media`, which is all the `generate_music` tool needs to route calls to MxAPI's Suno-compatible v2 API. Generation runs as an asynchronous generate-and-task flow that yields two candidate tasks per request, and the provider resolves the `MXAPI_API_KEY` credential per operation through `ctx.credentials`. Choose this bundle when a deployment generates BGM or songs through MxAPI; a provider that is not mounted is simply absent from the music registry.

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

Mount the provider bundle next to the media seam in any composition that runs the generation tools. This package ships its own profile-layer patch, so it also installs with `dsh plugin --profile <name> add @roubaai/media-mxapi`; either way the mounted row is the same `media-mxapi` plugin.

```yaml
- name: '@roubaai/media'
- name: '@roubaai/media-mxapi'
```

The provider resolves its key from the credential store: the default reference is the `MXAPI_API_KEY` environment variable, and `apiKeyEnv` overrides that name. A missing key surfaces as a provider-side missing-credential error at generation time, not at mount.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | MxAPI public API | Endpoint base override |
| `model` | `chirp-bluejay` | Default Suno model version (`mv`) |
| `apiKeyEnv` | `MXAPI_API_KEY` | Credential reference (environment-variable name) |

Every field is optional; the defaults above are the shipped behavior. A field set through the mounted row's `config` overrides the default for that row.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider bundle; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The bundle is thin on purpose: it implements the `MusicProvider` contract from `dsh-media` and registers it with `ctx.media.registerMusicProvider`. The tool schema, background-job lifecycle, and cost ledger all live in the seam package, so the provider stays replaceable and the model-facing surface unchanged.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema and provider registration |
| [`src/mxapi-music-provider.ts`](src/mxapi-music-provider.ts) | The `MxapiMusicProvider`: Suno-style v2 async generate-and-task flow |

### Key resolution

Each generation resolves `MXAPI_API_KEY` (or the configured `apiKeyEnv` name) through `ctx.credentials` at operation time, never at mount. That keeps key rotation live and keeps the plugin from failing to load when a key is not yet configured.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [dsh-media](../media/README.md) — the `ctx.media` seam and the `generate_music` tool this provider feeds.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `generate_music` tool in `dsh-media`, which owns the model-facing schema, description, and result envelope; this backend only executes generation and reports provider state.

#### KV Cache effect

No direct invalidation; the media tool rows own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the MxAPI backend is a poor fit or needs special operational care. They are current package constraints.

- **Requires the media seam and a mounted companion** — without a `dsh-media` row the provider never registers, and without the seam's tool rows there is nothing to call it.
- **Keyed per operation** — generation fails with a missing-credential error when `MXAPI_API_KEY` (or `apiKeyEnv`) is absent or revoked; the error surfaces at call time, not at mount.
- **Two candidates, one result** — a single request yields two candidate tasks; the generation tool resolves as soon as the first completes and reports the sibling's terminal state, so a workflow needing both tracks must call again.
- **Provider URLs expire** — MxAPI result URLs are time-limited, so wanted media must be persisted with `media_asset_save` before they expire.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
