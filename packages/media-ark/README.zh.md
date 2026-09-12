---
description: "ctx.media 缝的火山方舟后端：用部署自己的方舟 API Key，经方舟自有接口生成图片（Seedream）与视频（Seedance），并实时读取当前可请求的模型目录。"
kind: "package-bundle"
---

# @roubaai/media-ark

[English](README.md) | 中文

## 概要

`@roubaai/media-ark` 为图片与视频生成提供火山方舟后端。与 `@roubaai/media` 并排挂载时，它向 `ctx.media` 各注册一个图片提供商与视频提供商，而这正是 `generate_image` 与 `generate_video` 把调用路由到方舟所需的全部条件。它直连方舟自有接口 —— 图片走 `POST /images/generations`（Seedream），视频走 `POST /contents/generations/tasks` 并经 `GET /contents/generations/tasks/{id}` 轮询（Seedance）—— 使用部署自己的 `ARK_API_KEY`，因此部署可以直连方舟，不必再经过聚合网关中转。

它同时是这两个类别的出厂默认：未配置的部署，图片与视频都解析到 `ark`（音乐仍为 `mxapi`）。Settings 页上的提供商行通过把 **adapter** 填成 `ark` 来显式选用本后端；即使没有任何行，未配置的类别运行的仍是它。

方舟模型 id 带版本日期段（`doubao-seedream-5-0-pro-260628`、`doubao-seedance-2-0-260128`），且方舟会按自己的节奏退役它们，因此本包从不把已配置的 id 当作承诺。两个提供商都实现 `listModels()`，读取 `GET {base}/models`，报告该部署此刻真正可请求的模型。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把提供商 bundle 与媒体缝并排挂载。本包自带 profile 层补丁，因此也可以用 `dsh plugin --profile <name> add @roubaai/media-ark` 安装；无论哪种方式，挂载的行都是同一个 `media-ark` 插件。

```yaml
- name: '@roubaai/media'
- name: '@roubaai/media-ark'
```

然后在 Settings 页新增或编辑一个提供商行：把 **adapter** 设为 `ark`，接口地址填 `https://ark.cn-beijing.volces.com/api/v3`（或留空以使用该默认值），并粘贴方舟的 API Key。选中该行，工具就会用它。「模型」一栏给出方舟当前提供的 id（见 [模型目录](#model-catalogue)），同时保留自由输入兜底。

### 配置项

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | `https://ark.cn-beijing.volces.com/api/v3` | 端点基地址覆盖 |
| `imageModel` | `doubao-seedream-5-0-260128` | 默认图片模型 id（不带 `pro` 的 lite 档 Seedream 5.0） |
| `videoModel` | `doubao-seedance-2-0-mini-260615` | 默认视频模型 id；每次视频调用都可显式指定 |
| `apiKeyEnv` | `ARK_API_KEY` | 凭据引用（环境变量名） |
| `settingsNamespace` | `roubaai-video-plugin` | 提供商读取当前激活行的设置命名空间 |

每个字段都可选；上表默认值即出厂行为。通过挂载行的 `config` 设置的字段会覆盖该行的默认值。Settings 页里存的 key 优先于凭据库，因此从不打开该页的部署仅靠 `ARK_API_KEY` 也能正常工作。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

### 源码位置

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema 与两个提供商的注册 |
| [`src/ark-image-provider.ts`](src/ark-image-provider.ts) | `ArkImageProvider`：Seedream 提交、尺寸映射、上限、结果落盘与模型目录 |
| [`src/ark-video-provider.ts`](src/ark-video-provider.ts) | `ArkVideoProvider`：任务提交、轮询、上限、结果探测与模型目录 |
| [`src/ark-models.ts`](src/ark-models.ts) | `GET /models` 的解析与过滤，两个提供商共用 |
| [`src/http.ts`](src/http.ts) | JSON 调用、只读结果探测、字节下载，以及方舟的错误信封 |
| [`src/errors.ts`](src/errors.ts) | 两个提供商共同抛出的「缺少凭据」错误 |

### 请求映射

方舟收的是多模态 `content` 数组，而不是扁平的提示词加图片列表，因此缝的提供商无关视频输入映射为带类型的条目：

| 缝输入 | 方舟 `content` 条目 |
|---|---|
| `prompt` | `{ type: 'text', text }` |
| `imageUrls`（一张） | `{ type: 'image_url', image_url: { url }, role: 'first_frame' }` |
| `imageUrls`（多张） | 每个 URL 一个 `image_url` 条目，`role: 'reference_image'` |
| `imageWithRoles` | 每个条目一个 `image_url` 条目，`role` 原样透传 |
| `videoUrls` | `{ type: 'video_url', video_url: { url }, role: 'reference_video' }` |
| `audioUrls` | `{ type: 'audio_url', audio_url: { url }, role: 'reference_audio' }` |

`size` 对应方舟的 `ratio`，`generationType: 'video_edit'` 对应 `omni_reference_task_type: 'edit'`。需要首尾帧、或需要混用帧图与参考图的调用方，请通过 `imageWithRoles` 明确表达：上面的一条/多条规则是默认行为，不是对意图的猜测。

图片请求则是扁平请求体：`model`、`prompt`、`response_format: 'url'`、`watermark: false`、`sequential_image_generation: 'disabled'` 与 `size`。`refImages` 对应方舟的 `image` —— 一张参考图传字符串，多张传数组；`extra` 可透传或覆盖方舟文档化的图片字段（`watermark`、`output_format`、`sequential_image_generation`、`sequential_image_generation_options`、`optimize_prompt_options`、`background`、`response_format`）。`extra` 里的其它键一律忽略，不会发往计费接口。

`size` 分三步解析：显式的 `width`/`height` 原样使用；否则用分辨率档位加宽高比，在该模型世代支持的档位上查方舟文档给出的像素表；再否则直接把档位字符串交给方舟自行解析。最后这条兜底是刻意的：对无法归类的模型 id 猜像素尺寸，只会换来方舟拒绝的请求。方舟文档给出每个世代支持的档位（Seedream 5.0 pro 支持 1K/1.5K/2K；不带 `pro` 的 5.0 即 lite 档，支持 2K/3K/4K；4.5 支持 2K/4K；4.0 支持 1K/2K/4K），`caps()` 也正是据此报告参考图上限（5.0 pro 为 10，其余为 14）。

不带 `pro` 的 5.0 id（`doubao-seedream-5-0-260128`）属于 lite 档，方舟对它强制 **3,686,400 像素下限**：`size=1536x1536` 会被拒绝，`size=1.5K` 更不是合法取值。解析出的尺寸低于该下限时，本包会在请求发出前、也就是计费之前拒掉它，并在消息里写明下限与实际像素数。

`capabilities(model)` 把上述事实整理成每个模型一份的机器可读描述（档位、像素下限、参考图上限、像素表能解析的比例、一句提示）。它既是 `generate_image` 做调用时校验的唯一来源，也是 Settings 页展示的内容，因此厂商改档位只需改 `IMAGE_GENERATIONS` 一行。无法归类的 id 返回 `undefined`，工具随即原样放行该请求。

生成结果会回报实际运行的内容：`providerMeta.model` 指出所用模型（显式的 `input.model` 覆盖默认配置，工具正是借此把请求改到兄弟模型），`run` 则带上模型、档位与方舟返回的成图像素尺寸。

方舟的视频状态词表归一化为：`succeeded` → succeeded，`failed` 与 `expired` → failed，`queued` / `running` → running。轮询中遇到确定性的 4xx 会立即判定任务失败，并把状态以中文渲染出来，因此「key 不对」或「模型无权访问」会如实呈现，而不是拖成轮询超时。

### 模型目录

<a id="model-catalogue"></a>

方舟的模型 id 带日期段且会退役，因此两个提供商都实现了缝的可选目录能力：

```ts
provider.listModels?.(signal)                 // → MediaModelInfo[]（{ id, status?, taskTypes? }）
provider.listModelsWithDraft?.(draft, signal) // 同上，但用表单里尚未保存的端点与 key
```

`listModels()` 读取 `GET {base}/models`，按方舟自报的能力过滤：视频提供商取 `task_type` 含 `Video` 的条目，图片提供商取 `task_type` 含 `Image` 且 id 含 `seedream` 的条目。`listModelsWithDraft` 的存在，是为了让 Settings 页在保存任何东西之前就能浏览目录、顺带验证 key；草稿字段为空表示「用已配置的值」。Settings 页通过 `@roubaai/settings` 的 `models.list` 路由访问这两者。

因为方舟已不再提供某个模型而被拒的提交，会被如实报告，而不是笼统地报成「任务不存在」：提供商给出方舟自己的错误码与原文，并附上方舟当前提供的 id，例如：

```
Ark video submission failed [404]（InvalidEndpointOrModel.NotFound）The model or endpoint does not exist；可用模型：doubao-seedance-2-0-mini-260615、doubao-seedance-2-0-260128
```

若此时目录也读不到，该失败会写在同一行里，而不会顶掉方舟的原文。

### 探测一行配置

`probe(draft)` 返回三种状态之一，因为「还没填」和「填了但方舟拒绝」对看页面的人来说是两件事：

| 状态 | 触发条件 | 页面显示 |
|---|---|---|
| `ok` | `GET {base}/models` 返回 200 | 绿色 |
| `unconfigured` | 任何地方都没有 key：草稿为空、该行未保存、`ARK_API_KEY` 也解析不到 | 中性色 —— 什么都没探测，也就没有失败 |
| `failed` | 有 key，但方舟拒绝了 | 红色，并带上 HTTP 状态与方舟自己的 `error.message` |

key 的来源顺序就是上表所述：表单草稿 → 已保存的行 → 凭据库/环境变量。因此 key 刚敲进去就能顺带验证，而只配了 `ARK_API_KEY` 的部署同样能探测。`probe` 是只读的：它读模型目录，绝不触发生成。

### 上限与计价

`caps(model)` 匹配模型 id 中的代际片段（`seedance-2-5`、`seedance-2-0`、`seedance-1-5`；`seedream-5-0-pro`、`seedream-5-0-lite`、不带前缀的 `seedream-5-0`、`seedream-4-5`、`seedream-4-0`）；都匹配不上时取最保守的一组，从而在计费前就拒掉超规格请求。每条模式都要求版本号前不是数字，因此发布日期段（`…-4-0-250828` 里含有 `50`）不会被读成版本；`capabilities(model)` 则以缝要求的机器可读形式报告同一张表。`estimateCostUsd` 返回 `undefined` —— 原因见下方限制。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-media](../media/README.md) —— `ctx.media` 缝、`generate_image` / `generate_video` 工具，以及本后端接入的适配器选择机制。
- [dsh-settings](../settings/README.md) —— Settings 页、它的 `models.list` 路由，以及读取本目录的模型选择控件。

-----

<a id="model-experience"></a>
## 模型体验

间接体现：经 `dsh-media` 的 `generate_image` / `generate_video`，由它负责模型可见的 schema、描述与结果信封；本后端只执行生成并上报方舟的状态。模型目录只能经 Settings 页路由访问，不作为工具暴露。

#### KV Cache 影响

无直接失效；媒体工具行拥有任何请求前缀变化。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **无 USD 成本估算。** 方舟按人民币计价且有限时折扣，因此 `estimateCostUsd` 返回 `undefined`，成本账对该次运行只记录、不估价，而不是按本包并不掌握的外汇比率换算。要换算需要部署自行配置汇率。
- **模型 id 不在本地校验。** 提供商接受任意 id，由方舟拒绝未知的那个；方舟的拒绝里带着当前目录，下一次尝试即可改用仍在售的 id。两次调用之间不会对已存 id 做预校验 —— 要检查请调用 `listModels()`。
- **结果 URL 的有效期是假设值。** 方舟未声明产物文件的过期时间，因此两个提供商都套用其它适配器使用的 24 小时策略。想要的资产请在失效前用 `media_asset_save` 落盘。
- **任务 id 7 天后失效。** 方舟在任务创建 7 天后清除任务 id；此后轮询返回 404，任务会被上报为失败。
- **图片尺寸表取自方舟文档。** 对无法归类的世代，本包传的是分辨率档位字符串而不是像素尺寸；新增世代意味着往 `IMAGE_GENERATIONS` 加一行、并补齐 `PIXELS_BY_RATIO` 里对应的档位。
