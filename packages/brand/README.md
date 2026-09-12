---
description: "The Rouba DSH brand occupants for the Web client: how the sidebar and conversation-hero brand slots get the Rouba mark and name through one declaration-aware registration set."
kind: "package-reference"
---

# @roubaai/brand

English | [中文](README.zh.md)

## Summary

`@roubaai/brand` fills the generic browser-brand slots — `sidebar.brand.mark`, `sidebar.brand.name`, and `conversation.hero.brand.mark` — with the Rouba DSH brand. It registers occupants unconditionally: a deployment that mounts this plugin is Rouba-branded. The official `@deepseek-ai/dsh-client-ui-brand-official` occupant registers only when the client is built with `DSH_CLIENT_BUILD_PROFILE=official`, so in ordinary Rouba builds the two never collide; an official-profile build that also mounts this package would register two occupants on the `single` brand slots and must instead disable one of the two rows. Choose this package when the Web surface should carry the Rouba mark and name.

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

Mount the package as a browser-roster row in the web-app composition; the node half is an empty Loader seat and the browser half registers the occupants when the client activates.

```yaml
- id: roubaai-brand
  name: '@roubaai/brand'
```

Unlike its siblings in this repository, this package ships **no `dsh.bundle`**: it contributes no host service and no composition patch of its own, so `dsh plugin add` cannot reconcile it and the row is written into a composition file instead. Mount it beside the official occupant, then disable one of the two — an official-profile client (`DSH_CLIENT_BUILD_PROFILE=official`) that keeps both rows registers two occupants onto the same `single` brand slots.

### What the occupants cover

| Slot | Occupant |
|---|---|
| `sidebar.brand.mark` | `RoubaBrandMark` |
| `sidebar.brand.name` | `RoubaBrandName` |
| `conversation.hero.brand.mark` | `RoubaBrandMark` |

The browser title is a build-environment concern (`DSH_CLIENT_TITLE`) outside this package.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the brand package; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The three occupants install as one declaration-aware registration set through nested `ctx.slots.inject()` calls. The package therefore works whether its row activates before or after the sidebar and conversation declarers, withdraws all occupants when either declaration collapses, and leaves no partial brand mix during HMR. It retains no runtime state.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Node-half plugin entry: empty Loader seat |
| [`src/client/index.ts`](src/client/index.ts) | Browser-half registration set over the brand slots |
| [`src/client/Brand.tsx`](src/client/Brand.tsx) | The `RoubaBrandMark` and `RoubaBrandName` occupants |

### Profile gating

The official occupant guards its own registration on `DSH_CLIENT_BUILD_PROFILE === 'official'`, so the two packages are mutually exclusive by build profile rather than by runtime check. Rouba registers unconditionally because every build of a Rouba-branded deployment is non-official.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [`settings/README.md`](../settings/README.md) — the sibling package that carries the composition-patch pattern this one deliberately does without.
- [`media/README.md`](../media/README.md) — the provider seam the rest of the family is built around.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the package is a poor fit or needs special operational care. They are current package constraints.

- **The package supplies one occupant set** — a distinct Rouba mark (beyond the shared fish mark) belongs in a later iteration or a sibling occupant package.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.
- **Two occupants cannot share a slot** — an official-profile build that keeps both brand rows must disable one, because each `single` slot holds at most one occupant.
- **No `dsh.bundle`, so no plugin-channel install** — the row reaches a composition by being written into it, which is why every consumer of this package carries its own patch file.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package lives here rather than in the harness checkout because it is product presentation, not harness capability: keeping it out is what lets the harness side stay a plain upstream follower. Consumers mount the built `lib/` — `desktop/dsh-desktop/vendor/rouba/brand` on the desktop side, a packed tgz on the server side — so a change here must be followed by a rebuild and a re-sync, never by editing a vendored copy.

</details>
