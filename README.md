---
description: "Package map for the roubaai-video-plugin media generation family: the provider registry and its generate_* tools, the MaiziAI and MxAPI backends, and the settings surface that configures them."
kind: "package-group"
---

# roubaai-video-plugin/ — media generation family

English | [中文](README.zh.md)

## Summary

The `roubaai-video-plugin/` group generates images, video, and music for the model and lands every result as a durable attachment. One registry service owns the backends; the model calls `generate_image`, `generate_video`, or `generate_music` without ever naming a backend, so adding or replacing one changes no tool name and no session history. The `settings` package adds a Settings page for the provider key, endpoint, and models, and the backends read it per operation before falling back to the credential store and the environment. Every completed generation writes one line to a workspace cost ledger, which `media_cost_summary` folds into a readable total.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

These four packages provide the seam, its backends, and their configuration surface; each README describes what you can do with its part.

| Package | Role | ctx key |
|---|---|---|
| [`media/`](media/README.md) | The provider registry and every model-facing `generate_*` tool | `ctx.media`, `ctx.mediaUrl` |
| [`media-maizi/`](media-maizi/README.md) | MaiziAI backend for image and video generation | registers on `ctx.media` |
| [`media-mxapi/`](media-mxapi/README.md) | MxAPI backend for music generation | registers on `ctx.media` |
| [`settings/`](settings/README.md) | Settings page and namespace owning the provider key, endpoint, and models | owns the `roubaai-video-plugin` settings namespace |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the service contract, then the capability-seam table and the configuration surface of the packages in this group.

- [Media subsystem reference](../../docs/subsystems/media.md) — service contract, provider registration, the `generate_*` tools, and the cost ledger.
- [Capability seams](../../docs/capability-seams.md) — the Service Definition / Service Provider / Consumer split this family follows.
- [Generated configuration catalog](../../docs/config-catalog.md) — every accepted field of the packages in this group.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No shipped bundle patch mounts these rows: each package carries its own `dsh.bundle.patch`, so a deployment installs them through the plugin channel instead of by editing a composition file —

```
dsh plugin --profile <name> add <media> <media-maizi> <media-mxapi> <settings>
```

`media` must come first: the backends register onto the registry that row provides.

Two composition facts are load-bearing. The registry and its backends must share one realm — a backend mounting into another realm registers on a registry its consumers never read. And the settings row belongs on the host plane, because a settings namespace is a process-wide singleton.



</details>
