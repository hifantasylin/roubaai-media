---
description: "Package map for the roubaai plugin family: the provider registry and its generate_* tools, the MaiziAI, MxAPI, and Volcengine Ark backends, the settings surface that configures and selects them, and the Rouba brand occupant set."
kind: "package-group"
---

# roubaai-media — media generation family

English | [中文](README.zh.md)

## Summary

This repository generates images, video, and music for the model and lands every result as a durable attachment. One registry service owns the backends; the model calls `generate_image`, `generate_video`, or `generate_music` without ever naming a backend, so adding or replacing one changes no tool name and no session history. The `settings` package adds a Settings page that owns each backend's key, endpoint, and models **and selects which of the mounted backends a category runs**: a provider row names its adapter, and the tools resolve their provider from the active row. Every completed generation writes one line to a workspace cost ledger, which `media_cost_summary` folds into a readable total. `brand` stands outside that story: it fills the Web client's sidebar and conversation-hero brand slots with the Rouba mark.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

These six packages provide the seam, its backends, their configuration surface, and the brand occupants; each README describes what you can do with its part.

| Package | Role | ctx key |
|---|---|---|
| [`media/`](media/README.md) | The provider registry and every model-facing `generate_*` tool | `ctx.media`, `ctx.mediaUrl` |
| [`media-maizi/`](media-maizi/README.md) | MaiziAI backend for image and video generation | registers on `ctx.media` |
| [`media-ark/`](media-ark/README.md) | Volcengine Ark backend for image and video generation, and the default for both categories | registers on `ctx.media` |
| [`media-mxapi/`](media-mxapi/README.md) | MxAPI backend for music generation | registers on `ctx.media` |
| [`settings/`](settings/README.md) | Settings page and namespace owning each backend's key, endpoint, and models, and the adapter each category runs | owns the `roubaai-video-plugin` settings namespace |
| [`brand/`](brand/README.md) | Rouba brand occupants for the Web client's sidebar and conversation-hero slots | `slots` (browser half only) |

A backend registers under its registry name — `maizi`, `ark`, `mxapi` — and that name is what a provider row's adapter holds. Several backends may be mounted at once; only the active row's adapter runs.

-----

<a id="related-documentation"></a>
## Related documentation

- [`media/README.md`](media/README.md) — the registry, the provider contract every backend implements, and the `generate_*` tools.
- [`settings/README.md`](settings/README.md) — the stored configuration shape, the adapter field, and the Settings page.
- [`media-ark/README.md`](media-ark/README.md) — the Ark request mapping, caps, and the cost-ledger limitation that comes with RMB pricing.
- [`brand/README.md`](brand/README.md) — the occupant set that brands the Web client, and why it takes a composition patch instead of the plugin channel.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No shipped bundle patch mounts these rows: each package carries its own `dsh.bundle.patch`, so a deployment installs them through the plugin channel instead of by editing a composition file —

```
dsh plugin --profile <name> add <media> <settings> <media-maizi> <media-mxapi> <media-ark>
```

`media` must come first: the backends register onto the registry that row provides. Mounting a backend is not selecting it — a row on the Settings page names the adapter that runs.

`brand` is the one package the channel cannot take, because it declares no `dsh.bundle` at all: it contributes no host service and no patch of its own. A consumer adds it as an explicit row in a composition file, and disables the official brand occupant in the same patch — both land on the same `single` slots.

Two composition facts are load-bearing. The registry and its backends must share one realm — a backend mounting into another realm registers on a registry its consumers never read. And the settings row belongs on the host plane, because a settings namespace is a process-wide singleton.



</details>
