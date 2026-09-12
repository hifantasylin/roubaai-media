---
description: "roubaai 媒体生成家族的包地图：提供方注册表与 generate_* 工具、MaiziAI / MxAPI / 火山方舟后端，以及配置并选用它们的设置界面。"
kind: "package-group"
---

# roubaai-media — 媒体生成家族

[English](README.md) | 中文

## Summary

本仓库为模型生成图像、视频与音乐，并把每次结果都落地为持久化附件。一个注册表服务持有全部后端；模型调用 `generate_image`、`generate_video` 或 `generate_music` 时从不指名后端，因此新增或替换后端不会改变任何工具名与会话历史。`settings` 包提供设置页面，既持有每个后端的密钥、端点与模型，**也决定每个类别实际运行哪个已挂载后端**：提供商行指名自己的适配器，工具再按当前激活行解析出提供方。每次生成完成都会往工作区成本账本写一行，`media_cost_summary` 会把它折成可读的汇总。

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

这五个包分别提供这条缝、它的后端以及配置界面；每个 README 描述各自那部分能做什么。

| 包 | 作用 | ctx 键 |
|---|---|---|
| [`media/`](media/README.zh.md) | 提供方注册表与全部面向模型的 `generate_*` 工具 | `ctx.media`、`ctx.mediaUrl` |
| [`media-maizi/`](media-maizi/README.zh.md) | 图像与视频生成的 MaiziAI 后端 | 注册到 `ctx.media` |
| [`media-ark/`](media-ark/README.zh.md) | 视频生成的火山方舟后端 | 注册到 `ctx.media` |
| [`media-mxapi/`](media-mxapi/README.zh.md) | 音乐生成的 MxAPI 后端 | 注册到 `ctx.media` |
| [`settings/`](settings/README.zh.md) | 持有每个后端密钥、端点与模型的设置页面与命名空间，并决定每个类别运行的适配器 | 持有 `roubaai-video-plugin` 设置命名空间 |

后端以注册表名注册 —— `maizi`、`ark`、`mxapi` —— 该名字正是提供商行 `adapter` 字段所填的内容。可以同时挂载多个后端；实际运行的只有当前激活行的适配器。

-----

<a id="related-documentation"></a>
## Related documentation

- [`media/README.zh.md`](media/README.zh.md) —— 注册表、每个后端都要实现的提供方契约，以及 `generate_*` 工具。
- [`settings/README.zh.md`](settings/README.zh.md) —— 存储的配置形状、`adapter` 字段与设置页面。
- [`media-ark/README.zh.md`](media-ark/README.zh.md) —— 方舟的请求映射、上限，以及人民币计价带来的成本账限制。

<a id="dev-note"></a>
## Dev Note

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

没有任何随仓库发布的 bundle patch 挂载这些行：每个包都自带 `dsh.bundle.patch`，因此部署方通过插件通道安装，而不是去改组合文件——

```
dsh plugin --profile <name> add <media> <settings> <media-maizi> <media-mxapi> <media-ark>
```

`media` 必须排在最前：后端要注册到它所提供的注册表上。挂载一个后端不等于选用它——运行哪一个由设置页面上的 `adapter` 决定。

有两条组合事实至关重要。注册表与其后端必须共享同一个 realm——后端若挂进另一个 realm，就会注册到消费者永远读不到的注册表上。另外设置行属于宿主机平面，因为设置命名空间是进程级单例。

</details>
