---
description: "Web 客户端的 Rouba DSH 品牌占位者：侧边栏与会话 Hero 的品牌插槽如何通过一组声明感知的注册集拿到 Rouba 标志与名称。"
kind: "package-reference"
---

# @roubaai/brand

[English](README.md) | 中文

## 概述

`@roubaai/brand` 用 Rouba DSH 品牌填充通用浏览器品牌插槽——`sidebar.brand.mark`、`sidebar.brand.name` 与 `conversation.hero.brand.mark`。它无条件注册占位者：挂载本插件的部署即 Rouba 品牌化。官方的 `@deepseek-ai/dsh-client-ui-brand-official` 占位者只在客户端以 `DSH_CLIENT_BUILD_PROFILE=official` 构建时注册，因此在普通 Rouba 构建中二者不会冲突；而以 official profile 构建却仍挂载本包的部署，会在 `single` 品牌插槽上注册两个占位者，必须禁用其中一行。当 Web 界面需要展示 Rouba 标志与名称时选择本包。

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

把本包作为 web-app 组合里的一行浏览器名单挂载；宿主机半场是一个空的 Loader 席位，浏览器半场在客户端激活时注册那些占位者。

```yaml
- id: roubaai-brand
  name: '@roubaai/brand'
```

与同仓的其他包不同，本包**不带 `dsh.bundle`**：它不贡献任何宿主机服务，也没有自己的组合补丁，因此 `dsh plugin add` 无法把它纳入调和，那一行必须写进组合文件。把它挂在官方占位者旁边，然后禁用二者之一——保留两行的 official profile 客户端（`DSH_CLIENT_BUILD_PROFILE=official`）会在同一批 `single` 品牌插槽上注册两个占位者。

### 占位者覆盖范围

| 插槽 | 占位者 |
|---|---|
| `sidebar.brand.mark` | `RoubaBrandMark` |
| `sidebar.brand.name` | `RoubaBrandName` |
| `conversation.hero.brand.mark` | `RoubaBrandMark` |

浏览器标题属于构建期环境变量（`DSH_CLIENT_TITLE`），不在本包范围内。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 —— 点击展开</summary>

本节解释品牌包背后的设计取舍；可观察的行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计思路

三个占位者通过嵌套的 `ctx.slots.inject()` 调用，作为一个声明感知的注册集一起安装。因此无论本行是在侧边栏与会话的声明者之前还是之后激活，本包都能工作；任一声明塌缩时会一并撤回所有占位者，HMR 期间也不会留下半个品牌。它不保留任何运行时状态。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 宿主机半场插件入口：空的 Loader 席位 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器半场：品牌插槽上的注册集 |
| [`src/client/Brand.tsx`](src/client/Brand.tsx) | `RoubaBrandMark` 与 `RoubaBrandName` 两个占位者 |

### 构建 profile 门控

官方占位者用 `DSH_CLIENT_BUILD_PROFILE === 'official'` 守住自己的注册，因此两个包是靠构建 profile 而非运行时检查互斥的。Rouba 无条件注册，因为 Rouba 品牌化部署的每一次构建都不是 official。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

当包级契约不够用时，读这些页面。

- [`settings/README.zh.md`](../settings/README.zh.md) — 同仓中采用组合补丁模式的兄弟包，本包刻意不用那一套。
- [`media/README.zh.md`](../media/README.zh.md) — 家族其余部分所围绕的提供方接缝。

-----

<a id="model-experience"></a>
## 模型体验

无。本包只贡献浏览器呈现，没有任何东西到达模型请求。

#### KV Cache effect

无；本包既不组装也不发送提供方请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与未决工作

这些限制界定了本包何时不合适、或需要额外的运维注意。它们是当前包的约束。

- **本包只提供一组占位者** —— 一个真正独立的 Rouba 标志（超出现有共享鱼形标志）属于后续迭代或另一个占位者包。
- **浏览器标题是独立的** —— `DSH_CLIENT_TITLE` 在构建期选择标题文本，而不是通过 UI 插槽。
- **两个占位者不能共用插槽** —— 保留两行品牌行的 official profile 构建必须禁用其中之一，因为每个 `single` 插槽最多容纳一个占位者。
- **没有 `dsh.bundle`，也就没有插件通道安装** —— 那一行是靠写进组合文件到达组合的，这正是本包的每个消费方都自带补丁文件的原因。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

本包放在这里而不是 harness 检出里，是因为它属于产品呈现而非 harness 能力：把它留在外面，正是让 harness 侧保持为纯粹的上游跟随者的前提。消费方挂载的是构建产物 `lib/` —— 桌面侧是 `desktop/dsh-desktop/vendor/rouba/brand`，服务器侧是打好的 tgz —— 因此在这里改动之后必须重建并重新同步，绝不能去改一份 vendor 副本。

</details>
