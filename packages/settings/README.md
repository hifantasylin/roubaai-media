---
description: "Provider configuration for the roubaai video plugin: the settings namespace, the fenced JSON route that serves it, and the Settings page section that edits the provider key, endpoint, and models."
kind: "package-bundle"
---

# @roubaai/settings

English | [中文](README.zh.md)

## Summary

`@roubaai/settings` owns the configuration surface of the media stack. Its host half registers the `roubaai-video-plugin` settings namespace and serves it through the plugin's own fenced JSON route; its browser half contributes the Settings page section where a person configures a provider row — its key, endpoint, model, and **adapter** — runs a connection test, and picks a model from the backend's live catalogue. The media providers read those values per operation, so editing the page takes effect without a restart and without touching the environment. The adapter is what selects a backend: several may be mounted at once, and the tools route to whichever one the active row names. Choose this package when a deployment should let someone configure media generation from the browser instead of exporting an API key.

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

Mount the row beside the media rows it configures. The row injects `webServer` and `settings`, so it mounts only in a composition that has both.

```yaml
- id: roubaai-settings
  name: '@roubaai/settings'
  inject: [webServer, settings]
```

The row takes no configuration of its own; every value it manages is edited on the Settings page. The section appears under Settings once the browser half loads; saving stores the namespace value, and **Test connection** sends a read-only probe to the endpoint with the stored key.

| Field | Role |
|---|---|
| API key | A `secret`-role field: written, never returned to the browser. The page shows whether one is saved, never its value. |
| Adapter | Which mounted backend serves this row: the picker shows the catalog's display name (`火山引擎` for `ark`, `麦子AI` for `maizi`, `MxAPI` for `mxapi`) and stores the registry name. The choices are the adapters this deployment mounted, read from `ctx.media`; a row whose stored adapter is no longer mounted keeps it as the only choice, so an edit cannot silently retarget the row. Empty resolves to the category's built-in adapter. |
| Endpoint base | Overrides the provider's default API base; empty means the provider default. |
| Model | The id every generation uses; empty means the provider's configured default. The control is a free-text input with the backend's live catalogue under it (read through `models.list`), because vendor ids carry a date segment and retire: a deployment must be able to move to a current id without turning its built-in row into a custom provider. A backend that cannot list models leaves the input in charge. |
| Resolution tier | The tier every generation from this row asks for; empty follows the default tier (2K). The choices **are** the tiers the chosen model declares, so a pairing the model cannot serve cannot be picked at all; a stored value the model no longer declares stays visible but is refused on save, with the reason. The control does not appear for a backend that reports no tiers (Maizi, mxapi). |

Every entry in the model catalogue also carries **that model's own capability** — its tiers, its reference-image bound, the ratios it accepts. All of it comes from the backend's own report; the page renders it and never keeps a second copy.

### Which model, which tier

| What you want | What to pick |
|---|---|
| Lightweight composition drafts, fast iteration | lite class + 2K |
| The 1.5K middle tier | pro class + 1.5K |
| Large, detailed output | lite class + 3K / 4K |
| Precise edits / many references / layer splitting | pro class |

Ids carry a date segment and retire, so this table names tier CLASSES (lite / pro), not one id: the catalogue the Settings page currently reads is what decides the id. The default row is the lite class at 2K. When a call asks for a tier the configured model does not have but a sibling in the catalogue does, the tool moves that request to the sibling and says so in the result — nobody has to come back and edit this page first.

Beside the endpoint sits **Get an exclusive API key**, whose target comes from the catalog too: one vendor console page per adapter (`https://console.volcengine.com/` for `ark`, the Maizi registration page for `maizi`). An adapter with no page this repository can vouch for shows no link at all rather than a guessed address — `mxapi` currently is such an adapter.

**Test connection** runs against the values the card shows, an unsaved key included. The row's adapter owns the probe: a provider implements `probe(draft)` because only it knows which request proves reachability and key acceptance for its own protocol. A row whose adapter is unmounted, or whose provider implements no probe, falls back to the route's generic endpoint probe.

The answer is one of **three states**, not a boolean:

| State | Meaning | Display |
|---|---|---|
| `ok` | the endpoint answered and accepted the key | green |
| `unconfigured` | no key exists anywhere the probe can see: no draft, nothing stored, no environment fallback | neutral |
| `failed` | a key exists and the backend refused it | red, with the status and the backend's own message |

`unconfigured` exists because a row nobody has filled in yet is a to-do, not a failure: painting it red makes "not set up" indistinguishable from "rejected", and teaches the reader to ignore red. The provider decides this, since it alone knows its credential reference; the generic fallback (which sees only the form and the stored document) checks those two and says so. Both probes are read-only — the OpenAI-compatible one reads `GET /models`, the music one looks up a task id that cannot exist — so a connection test can never create a billable generation. The row's key dot follows the same rule: "no key saved" is dimmed rather than red.

**Model choices** come from the same adapter, one level deeper: a provider that can enumerate its models implements the seam's optional `listModels(signal)` — and, so a key that has not been saved yet can browse too, `listModelsWithDraft(draft, signal)`. Both are detected structurally, so a backend without a model-list endpoint simply omits them and the row keeps its free-text input.

<a id="understand-the-implementation"></a>
## Understand the implementation

The host half registers the namespace with a schemastery schema and serves it from a route under `/api/roubaai-video` rather than through the harness settings RPC: that domain serves only allowlisted namespaces to configuration clients, so a third-party namespace reaches its browser surface this way. The route is fenced to same-origin requests and exposes four methods — `settings.get` (the redacted value with its revision, plus the mounted adapter catalog), `settings.update` (a write echoing that revision), `test` (a connection probe against the card's draft), and `models.list` (one row's backend model catalogue, again against the draft, so an unsaved key can browse before it is stored). The probe and the catalogue read must run server-side by construction: both need the plain key, which never crosses a wire.

`models.list` answers `{ models: [{ id, label?, status?, taskTypes?, capability? }], message? }`, where `capability` (tiers, pixel floor, reference bound, ratios) is filled in host-side — that half is the one holding a live provider, so a model choice and what that model accepts can never come from two different reads and disagree. The three outcomes are deliberate: a backend that implements no catalogue call answers an empty list with a note (never an error, so the form keeps its free-text input), an adapter this deployment did not mount is refused, and a backend's own failure propagates verbatim — a retired key or an unreachable endpoint must stay readable rather than be flattened into "no models".

The browser half imports only this package's dependency-free `shared` module, so no schema library reaches the client bundle. It injects one `settings.section` slot occupant and talks to the fenced route.

The contract with the providers is deliberately data-only: they read the namespace by name and pick four fields, with no import of this package. A deployment that never opens the Settings page is untouched — the providers fall through to the credential store and the environment.

<a id="further-exploration"></a>
## Further Exploration

- [`media-maizi/`](../media-maizi/README.md) — the image and video backend whose key, endpoint, and models this page configures.
- [`media-ark/`](../media-ark/README.md) — the default image and video backend, and the catalogue the model picker reads.
- [`media-mxapi/`](../media-mxapi/README.md) — the music backend reading the same namespace.
- [`media/`](../media/README.md) — the provider registry these values feed, and the tools that route by adapter.

<a id="model-experience"></a>
## Model Experience

None, as this package only owns the provider configuration namespace and its Settings page; it registers no tool, prompt section, or tool parameter.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- One namespace covers every provider reading it, so two deployments wanting different endpoints for image and video would need a second namespace.
- The connection test proves the key authenticates and the service answers. Whether a specific model is available to that key is what the model picker's catalogue shows — a backend that cannot list models leaves that unverified.
- The model picker suggests; it does not enforce. A typed id is accepted as-is, since a vendor's catalogue can lag a model it has already enabled for an account. The tier control beside it is the enforcing half: it offers only the tiers the chosen model declares, and refuses to save a stored tier that model no longer supports.
- Provider-reported cost is not surfaced on the page; the ledger records it per generation instead.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The namespace lives on the host plane because a settings namespace is a process-wide singleton: registering it from a provider row would make it appear and disappear with the per-session realm that row mounts into.

The route stays fenced to same-origin requests on purpose. It returns the secret's *presence*, never its value, and a write must echo the revision the previous read returned, so a stale form cannot silently overwrite a newer key.

</details>
