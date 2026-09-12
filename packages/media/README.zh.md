---
description: "媒体生成能力 seame：ctx.media 提供商注册表，加上 generate_image、generate_video、generate_music 与资产工具，以及如何在旁边挂载提供商。"
kind: "package-bundle"
---

# @roubaai/media

[English](README.md) | 中文

## 概述

`dsh-media` 让 dsh Agent 能够通过可替换的提供商生成并管理媒体。它挂载 `ctx.media` 注册表、`ctx.mediaUrl` 本地引用归一化器，以及七个与提供商无关的模型可见工具——`generate_image`、`generate_video`、`generate_music`、`media_asset_save`、`media_reference_url`、`media_extract_frame` 与 `media_cost_summary`。`dsh-media-maizi`、`dsh-media-mxapi` 等提供商 bundle 把图像、视频与音乐后端注册到同一个注册表；注册一个提供商即可把它接入工具。生成以后台任务方式运行，调用从不阻塞在长达数分钟的提供商工作上；结果通过会话的 `job_output` 到达，想要的媒体会在提供商 URL 过期前被持久化进工作区资产库。当组合需要让模型生产或引用图像、视频、音乐资产并保留按工作区统计的成本记录时，选择本包。

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

把媒体行与所需提供商行一起挂载；base 组合为工具运行提供 `tools`、`jobs` 与 `attachments` 服务。在本仓库中，媒体行随 base 补丁发布，web 会话则位于 standard agent preset 的媒体 realm 内；仓库外的组合显式挂载同样的行。

```yaml
- name: '@roubaai/media'
- name: '@roubaai/media-maizi'
- name: '@roubaai/media-mxapi'
```

媒体行本身不需要配置；每个提供商行各自配置自己的端点与凭据引用。提供商在每次操作时通过 `ctx.credentials` 解析凭据，因此默认环境变量名（`MAIZI_API_KEY`、`MXAPI_API_KEY`）可以不改挂载就覆盖。

### 工具的职责

| 工具 | 行为 |
|---|---|
| `generate_image` / `generate_video` / `generate_music` | 启动后台生成任务并返回其 id；结果携带提供商任务句柄与 24 小时媒体 URL |
| `media_asset_save` | 把生成或上传的资产持久化到 `<cwd>/.assets/<category>/<name>.<ext>` 并更新资产索引 |
| `media_reference_url` | 把本地或 host-local 引用重新发布为可供后续提供商调用的全新公共 URL |
| `media_extract_frame` | 从视频文件中抽取一帧 |
| `media_cost_summary` | 把工作区媒体成本账本汇总为面向所有者的可读摘要 |

每次生成任务都会向工作区成本账本（`<cwd>/.assets/<project>/media-cost.jsonl`）追加一行：视频与音乐为提供商上报值，图像为费率表估算值。账本的 project 与 label 参数来自模型调用，并驱动重试识别。

### 提供商选择

未指定提供商名的工具调用使用其所需种类下第一个注册的后端；当没有注册任何后端时，`NO_PROVIDER` 是由工具 guard 暴露的最终拒绝。因此挂载或移除提供商 bundle，只会改变工具解析到的后端，而无需触碰 seame 或其工具。

### 模型能力与档位：怎么选

每个模型能接受什么，由**提供商自己上报**（`capabilities(model)`）：可用分辨率档位、像素下限、参考图上限、支持比例。`generate_image` 的 `resolution` 参数因此**没有枚举** —— 各模型档位不同，写死的列表必然与后端脱节；调用时的校验、默认档位、以及"换一个能做的模型"，全部从这份能力派生。

| 想要的效果 | 选什么 |
|---|---|
| 轻量试构图、快速迭代 | lite 档 + 2K |
| 1.5K 中间档 | pro 档 + 1.5K |
| 大图细节 | lite 档 + 3K / 4K |
| 精细编辑 / 多图参考 / 图层拆分 | pro 档 |

模型 id 带日期段且会退役，所以这张表说的是**档位类**（lite / pro），不是某个具体 id。默认档位是 2K。调用要的档位当前模型没有、而目录里的兄弟模型有时，工具会把这次请求改到兄弟模型，并在任务结果里写明；没有任何模型能做时，调用失败并给出该模型支持的档位、像素下限，以及兄弟模型的档位。不做能力上报的后端（麦子AI、mxapi）保持原样：不校验、不替换、不补默认档位。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部 — 点击展开</summary>

本节解释 seame 背后的设计取舍；可观察行为已由[使用本包](#use-this-package)完整覆盖。

### 设计思路

本包复刻了 harness 的“抽象服务 + 适配器注册”分层：`ctx.media` 是提供商注册表，提供商自行注册并可被撤销，工具与提供商无关。所有模型可见内容——工具 schema、描述、后台任务生命周期与成本账本——都在这里，因此提供商只实现一条窄执行契约，永远不向模型渲染。

### 源文件地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：服务与工具的注册 |
| [`src/service.ts`](src/service.ts) | `ctx.media` 服务定义 |
| [`src/media-local.ts`](src/media-local.ts) | 进程内 `MediaRuntimeLocal` 注册表实现 |
| [`src/provider.ts`](src/provider.ts) | 图像/视频/音乐提供商契约、按模型的能力描述与共享结果类型 |
| [`src/tunnel.ts`](src/tunnel.ts) | `ctx.mediaUrl` 本地引用归一化器（静态服务器加隧道） |
| [`src/tools/`](src/tools/) | 七个模型可见工具的执行器 |
| [`src/cost-ledger.ts`](src/cost-ledger.ts) | 按工作区的媒体成本账本与汇总折叠 |

### 服务与工具注册

`new MediaRuntimeLocal(ctx)` 为 apply fiber 注册 `ctx.media`，`new MediaUrlNormalizer(ctx)` 注册 `ctx.mediaUrl`；行卸载时两者都会被撤销。工具通过 `defineTool` 注册进 `tools` 注册表，经 `ctx.jobs` 启动后台工作，并经 `ctx.attachments` 持久化结果。在 per-session preset realm 内，注册表与其提供商共享该 realm，每个会话看到自己挂载的那一套；在 host-plane 行上，它们共享进程级实例。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

当包级契约还不够时阅读以下页面。

- [dsh-media-maizi](../media-maizi/README.zh.md) — MaiziAI 图像与视频提供商 bundle。
- [dsh-media-mxapi](../media-mxapi/README.zh.md) — MxAPI 音乐提供商 bundle。

-----

<a id="model-experience"></a>
## 模型体验

### 媒体生成工具

#### 模型看到什么

`generate_image`、`generate_video` 与 `generate_music` 工具在一个提供商挂载到 `ctx.media` 后注册；每次调用都通过 `ctx.jobs` 启动后台任务并返回携带 `jobId` 的 `kind: background` 封装，因为生成耗时数十秒到数分钟。工具描述写明提供商默认模型与计费敏感选项（分辨率、参考图数量、音频、抽帧）；当所需种类没有注册后端时，deny guard 会给出 `no image provider is configured` 一类的拒绝。

`generate_image` 的 `resolution` 描述刻意不列档位，而是指向"能力来自服务该调用的适配器"：档位随模型而变，写死的列表正是此前那次无效调用的成因。任务结果的 `run` 字段回报实际运行的模型、档位与厂商返回的像素尺寸（`run.model` / `run.tier` / `run.size`），必要时还有 `run.requestedModel` 与 `run.switchNote`，让下一次调用能据此自我修正。

#### Token 影响

三个工具 schema 在它们处于工具视图内时是固定的请求开销；完成任务的文本结果在压缩前一直保留在会话中。

#### KV Cache 影响

在可见工具定义与顺序不变时前缀稳定；提供商配置不会改变请求前缀。

### 生成结果与资产

#### 模型看到什么

完成的任务通过会话的 `job_output` 上报提供商任务句柄与 24 小时媒体 URL。模型用 `media_asset_save` 把想保留的内容持久化到 `<cwd>/.assets/<category>/<name>.<ext>`（并维护 `assets-index.md`），用 `media_reference_url` 把本地或 host-local 路径重新发布为后续提供商调用可用的全新公共 URL，用 `media_extract_frame` 抽取视频帧。

#### Token 影响

结果与资产文本在压缩前一直保留；每个额外输出（音频、末帧、抽取帧）都会增加各自的结果文本与成本。

#### KV Cache 影响

普通结果追加式增长；新出现的可见内容跟在可复用请求前缀之后，不会使既有缓存条目失效。

### 媒体成本账本

#### 模型看到什么

每次完成的生成都会向 `<cwd>/.assets/<project>/media-cost.jsonl` 追加一行——视频与音乐为提供商上报值，图像为费率表估算值——`media_cost_summary` 工具再把账本折叠成面向所有者的可读总额，含按项目与按 label 的分解，以及对重复 label 的重试标记。

#### Token 影响

只有调用 `media_cost_summary` 才会把折叠后的摘要文本加入历史。

#### KV Cache 影响

前缀稳定；账本增长不属于请求前缀的一部分。

## 已知限制与未决工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定媒体能力何时不适用或需要特殊运维。它们是当前包约束。

- **生成受提供商与密钥门控** — 工具需要至少一个所需种类的提供商已挂载且其凭据可解析；两者任一缺失，调用会以 `NO_PROVIDER` 或 missing-credential 错误失败。
- **提供商 URL 会过期** — 生成结果携带约 24 小时的有效 URL，想要的媒体应在窗口关闭前用 `media_asset_save` 持久化。
- **本地引用需要公共 URL** — `media_reference_url` 通过本地静态服务器与隧道把本地与 host-local 路径变成公共 URL；部署缺少可用的隧道二进制时，本地引用媒体没有出路。
- **成本账本按工作区且带 rouba 口味** — 账本文件位于 `<cwd>/.assets/`，目录名来自模型提供的 `project` 标签（缺省回退到工作区），工具描述带有制作工作流词汇。
- **不做内联媒体交付** — 每个生成工具都是后台任务，输出是一个 job id；媒体只能以文本 URL 或落盘文件到达模型，绝不以内联结果块出现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
