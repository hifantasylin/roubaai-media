---
description: "Provider configuration for the roubaai video plugin: the settings namespace, the fenced JSON route that serves it, and the Settings page section that edits the provider key, endpoint, and models."
kind: "package-bundle"
---

# @roubaai/settings

English | [中文](README.zh.md)

## Summary

`@roubaai/settings` owns the configuration surface of the media stack. Its host half registers the `roubaai-video-plugin` settings namespace and serves it through the plugin's own fenced JSON route; its browser half contributes the Settings page section where a person enters the provider key, endpoint, image model, and video model, and runs a connection test. The media providers read those values per operation, so editing the page takes effect without a restart and without touching the environment. Choose this package when a deployment should let someone configure media generation from the browser instead of exporting an API key.

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
| Endpoint base | Overrides the provider's default API base; empty means the provider default. |
| Image model / Video model | Override the model each generation uses; empty means the provider's configured default. |

<a id="understand-the-implementation"></a>
## Understand the implementation

The host half registers the namespace with a schemastery schema and serves it from a route under `/api/roubaai-video` rather than through the harness settings RPC: that domain serves only allowlisted namespaces to configuration clients, so a third-party namespace reaches its browser surface this way. The route is fenced to same-origin requests and exposes three operations — read the redacted value with its revision, write a value while echoing that revision, and run a connection test. The test must run server-side by construction: it needs the plain key, which never crosses a wire.

The browser half imports only this package's dependency-free `shared` module, so no schema library reaches the client bundle. It injects one `settings.section` slot occupant and talks to the fenced route.

The contract with the providers is deliberately data-only: they read the namespace by name and pick four fields, with no import of this package. A deployment that never opens the Settings page is untouched — the providers fall through to the credential store and the environment.

<a id="further-exploration"></a>
## Further Exploration

- [`media-maizi/`](../media-maizi/README.md) — the image and video backend whose key, endpoint, and models this page configures.
- [`media-mxapi/`](../media-mxapi/README.md) — the music backend reading the same namespace.
- [Media subsystem reference](../../../docs/subsystems/media.md) — the provider registry these values feed.

<a id="model-experience"></a>
<a id="model-experience"></a>
## Model Experience

None, as this package only owns the provider configuration namespace and its Settings page; it registers no tool, prompt section, or tool parameter.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- One namespace covers every provider reading it, so two deployments wanting different endpoints for image and video would need a second namespace.
- The connection test proves the key authenticates and the service answers; it does not prove a specific model is available to that key.
- Provider-reported cost is not surfaced on the page; the ledger records it per generation instead.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The namespace lives on the host plane because a settings namespace is a process-wide singleton: registering it from a provider row would make it appear and disappear with the per-session realm that row mounts into.

The route stays fenced to same-origin requests on purpose. It returns the secret's *presence*, never its value, and a write must echo the revision the previous read returned, so a stale form cannot silently overwrite a newer key.

</details>
