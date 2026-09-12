---
description: "ctx.media 缝的火山方舟视频后端：用部署自己的方舟 API Key 调用方舟自有的异步生成任务接口。"
kind: "package-bundle"
---

# @roubaai/media-ark

[English](README.md) | 中文

## 概要

`@roubaai/media-ark` 为视频生成提供火山方舟后端。与 `@roubaai/media` 并排挂载时，它向 `ctx.media` 注册一个视频提供商，而这正是 `generate_video` 把调用路由到方舟所需的全部条件。它直连方舟自有任务接口 —— `POST /contents/generations/tasks`，经 `GET /contents/generations/tasks/{id}` 轮询 —— 使用部署自己的 `ARK_API_KEY`，因此部署可以直连方舟，不必再经过聚合网关中转。

Settings 页上的提供商行通过把 **adapter** 填成 `ark` 来选用本后端。没有这一选择时，提供商虽已挂载但不被使用：`generate_video` 路由到当前激活行所指名的适配器，而未配置的部署解析到注册表默认值。

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

然后在 Settings 页新增或编辑一个视频提供商行：把 **adapter** 设为 `ark`，接口地址填 `https://ark.cn-beijing.volces.com/api/v3`（或留空以使用该默认值），并粘贴方舟的 API Key。选中该行，`generate_video` 就会用它。

### 配置项

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | `https://ark.cn-beijing.volces.com/api/v3` | 端点基地址覆盖 |
| `videoModel` | `doubao-seedance-1-5-pro-251215` | 默认模型 id；每次调用都会显式指定一个 |
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
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema 与提供商注册 |
| [`src/ark-video-provider.ts`](src/ark-video-provider.ts) | `ArkVideoProvider`：任务提交、轮询、上限与结果探测 |
| [`src/http.ts`](src/http.ts) | JSON 调用与只读结果探测，含瞬时失败重试 |

### 请求映射

方舟收的是多模态 `content` 数组，而不是扁平的提示词加图片列表，因此缝的提供商无关输入映射为带类型的条目：

| 缝输入 | 方舟 `content` 条目 |
|---|---|
| `prompt` | `{ type: 'text', text }` |
| `imageUrls`（一张） | `{ type: 'image_url', image_url: { url }, role: 'first_frame' }` |
| `imageUrls`（多张） | 每个 URL 一个 `image_url` 条目，`role: 'reference_image'` |
| `imageWithRoles` | 每个条目一个 `image_url` 条目，`role` 原样透传 |
| `videoUrls` | `{ type: 'video_url', video_url: { url }, role: 'reference_video' }` |
| `audioUrls` | `{ type: 'audio_url', audio_url: { url }, role: 'reference_audio' }` |

`size` 对应方舟的 `ratio`，`generationType: 'video_edit'` 对应 `omni_reference_task_type: 'edit'`。需要首尾帧、或需要混用帧图与参考图的调用方，请通过 `imageWithRoles` 明确表达：上面的一条/多条规则是默认行为，不是对意图的猜测。

方舟的状态词表归一化为：`succeeded` → succeeded，`failed` 与 `expired` → failed，`queued` / `running` → running。轮询中遇到确定性的 4xx 会立即判定任务失败，并把状态以中文渲染出来，因此"key 不对"或"模型无权访问"会如实呈现，而不是拖成轮询超时。

### 上限与计价

`caps(model)` 匹配模型 id 中的代际片段（`seedance-2-5`、`seedance-2-0`、`seedance-1-5`）；都匹配不上时取方舟能接受的最保守的一组，从而在计费前就拒掉超规格请求。`estimateCostUsd` 返回 `undefined` —— 原因见下方限制。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-media](../media/README.md) —— `ctx.media` 缝、`generate_video` 工具，以及本后端接入的适配器选择机制。

-----

<a id="model-experience"></a>
## 模型体验

间接体现：经 `dsh-media` 的 `generate_video`，由它负责模型可见的 schema、描述与结果信封；本后端只执行生成并上报方舟的状态。

#### KV Cache 影响

无直接失效；媒体工具行拥有任何请求前缀变化。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **仅视频。** 方舟也提供图像模型；本包不注册图像提供商，因此 `generate_image` 无法路由到方舟。
- **无 USD 成本估算。** 方舟按人民币每秒计价且有限时折扣，因此 `estimateCostUsd` 返回 `undefined`，成本账对该次运行只记录、不估价，而不是按本包并不掌握的外汇比率换算。要换算需要部署自行配置汇率。
- **不校验模型 id。** 方舟模型 id 带日期后缀且随版本变动，因此提供商接受任意 id，由方舟拒绝未知的那个。`caps()` 对无法归类的 id 退到最保守的一组。
- **结果 URL 的有效期是假设值。** 方舟未声明产物文件的过期时间，因此提供商套用其它适配器使用的 24 小时策略。想要的资产请在失效前用 `media_asset_save` 落盘。
- **任务 id 7 天后失效。** 方舟在任务创建 7 天后清除任务 id；此后轮询返回 404，任务会被上报为失败。
