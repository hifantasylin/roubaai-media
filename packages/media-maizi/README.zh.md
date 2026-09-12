---
description: "ctx.media 的 MaiziAI 图像与视频生成后端：挂载它即向 generate_image 与 generate_video 工具注册图像与视频提供商。"
kind: "package-bundle"
---

# @roubaai/media-maizi

[English](README.md) | 中文

## 概述

`dsh-media-maizi` 为媒体生成能力提供 MaiziAI 后端。与 `dsh-media` 并排挂载时，它向 `ctx.media` 注册一个图像提供商与一个视频提供商，而这正是 `generate_image` 与 `generate_video` 工具把调用路由到 Maizi 所需的全部条件。图像生成走 Maizi 的同步端点，视频走其异步 v1 任务接口；两者都在每次操作时通过 `ctx.credentials` 解析 `MAIZI_API_KEY` 凭据。需要让部署通过 Maizi 生成图像与视频时选择本 bundle；未挂载的提供商会直接缺席媒体注册表，因此增删它只改变工具解析到的后端。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与未决工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在运行生成工具的任何组合中，把提供商 bundle 与媒体 seame 并排挂载。本包自带 profile 层补丁，因此也可以用 `dsh plugin --profile <name> add @roubaai/media-maizi` 安装；无论哪种方式，挂载的行都是同一个 `media-maizi` 插件。

```yaml
- name: '@roubaai/media'
- name: '@roubaai/media-maizi'
```

提供商从凭据库解析密钥：默认引用 `MAIZI_API_KEY` 环境变量，`apiKeyEnv` 可覆盖该名称。密钥缺失会在生成时以提供商侧 missing-credential 错误暴露，而不是在挂载时报错。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | Maizi 公共 API | 端点基地址覆盖 |
| `imageModel` | 提供商默认 | 默认图像模型 id |
| `videoModel` | 提供商默认 | 默认视频模型 id |
| `apiKeyEnv` | `MAIZI_API_KEY` | 凭据引用（环境变量名） |
| `pollTimeoutMs` | `60000` | 前台图像轮询上限（毫秒） |

所有字段均可选；上表默认值即发布行为。在挂载行的 `config` 中设置某个字段即可对该行覆盖默认值。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部 — 点击展开</summary>

本节解释提供商 bundle 背后的设计取舍；可观察行为已由[使用本包](#use-this-package)完整覆盖。

### 设计思路

这个 bundle 刻意保持轻薄：它实现 `dsh-media` 定义的两个提供商契约（`ImageProvider` 与 `VideoProvider`），并用 `ctx.media.registerImageProvider` 与 `registerVideoProvider` 注册。工具 schema、后台任务生命周期与成本账本都在 seame 包内，因此提供商保持可替换，模型可见面保持不变。

### 源文件地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema 与提供商注册 |
| [`src/maizi-image-provider.ts`](src/maizi-image-provider.ts) | `MaiziImageProvider`：带前台轮询上限的同步 v2 图像生成 |
| [`src/maizi-video-provider.ts`](src/maizi-video-provider.ts) | `MaiziVideoProvider`：异步 v1 视频任务提交与轮询 |

### 密钥解析

每次生成都在操作时通过 `ctx.credentials` 解析 `MAIZI_API_KEY`（或配置的 `apiKeyEnv` 名称），而不是在挂载时解析。这保证密钥轮换即时生效，也避免在密钥尚未配置时插件加载失败。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

当包级契约还不够时阅读以下页面。

- [dsh-media](../media/README.zh.md) — 本提供商供料的 `ctx.media` seame 与 `generate_image`/`generate_video` 工具。

-----

<a id="model-experience"></a>
## 模型体验

间接地，经由 `dsh-media` 中的 `generate_image` 与 `generate_video` 工具，它们拥有模型可见的 schema、描述与结果封装；本后端只执行生成并回报提供商状态。

#### KV Cache 影响

无直接失效；媒体工具行拥有任何请求前缀变化。

## 已知限制与未决工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定 Maizi 后端何时不适用或需要特殊运维。它们是当前包约束。

- **需要媒体 seame 与并排挂载的配套** — 没有 `dsh-media` 行提供商就不会注册，没有 seame 的工具行也就没有东西调用它。
- **按操作取密钥** — `MAIZI_API_KEY`（或 `apiKeyEnv`）缺失或吊销时生成以 missing-credential 错误失败；错误在调用时暴露，而非挂载时。
- **提供商 URL 会过期** — Maizi 结果 URL 有时限，想要保留的媒体应在过期前用 `media_asset_save` 持久化。
- **默认模型是 Maizi 的** — 未设置 `imageModel`/`videoModel` 时，实际模型跟随 Maizi 服务默认值。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
