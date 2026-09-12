---
description: "roubaai-video-plugin 媒体生成家族的包地图：提供方注册表与 generate_* 工具、MaiziAI 与 MxAPI 后端，以及配置它们的设置界面。"
kind: "package-group"
---

# roubaai-video-plugin/ — 媒体生成家族

[English](README.md) | 中文

## Summary

`roubaai-video-plugin/` 组为模型生成图像、视频与音乐，并把每次结果都落地为持久化附件。一个注册表服务持有全部后端；模型调用 `generate_image`、`generate_video` 或 `generate_music` 时从不指名后端，因此新增或替换后端不会改变任何工具名与会话历史。`settings` 包为提供方密钥、端点与模型提供设置页面，后端在每次操作时先读它，再回落到凭据存储与环境变量。每次生成完成都会往工作区成本账本写一行，`media_cost_summary` 会把它折成可读的汇总。

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

这四个包分别提供这条缝、它的后端以及配置界面；每个 README 描述各自那部分能做什么。

| 包 | 作用 | ctx 键 |
|---|---|---|
| [`media/`](media/README.zh.md) | 提供方注册表与全部面向模型的 `generate_*` 工具 | `ctx.media`、`ctx.mediaUrl` |
| [`media-maizi/`](media-maizi/README.zh.md) | 图像与视频生成的 MaiziAI 后端 | 注册到 `ctx.media` |
| [`media-mxapi/`](media-mxapi/README.zh.md) | 音乐生成的 MxAPI 后端 | 注册到 `ctx.media` |
| [`settings/`](settings/README.zh.md) | 持有提供方密钥、端点与模型的设置页面与命名空间 | 持有 `roubaai-video-plugin` 设置命名空间 |

-----

<a id="related-documentation"></a>
## Related documentation

建议先读子系统参考了解服务契约，再看能力缝表格与本组各包的配置面。

- [媒体子系统参考](../../docs/subsystems/media.zh.md) — 服务契约、提供方注册、`generate_*` 工具与成本账本。
- [能力缝](../../docs/capability-seams.zh.md) — 本家族遵循的 Service Definition / Service Provider / Consumer 划分。
- [生成的配置目录](../../docs/config-catalog.zh.md) — 本组各包接受的每一个配置项。

<a id="dev-note"></a>
## Dev Note

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

没有任何随仓库发布的 bundle patch 挂载这些行：每个包都自带 `dsh.bundle.patch`，因此部署方通过插件通道安装，而不是去改组合文件——

```
dsh plugin --profile <name> add <media> <media-maizi> <media-mxapi> <settings>
```

`media` 必须排在最前：后端要注册到它所提供的注册表上。

有两条组合事实至关重要。注册表与其后端必须共享同一个 realm——后端若挂进另一个 realm，就会注册到消费者永远读不到的注册表上。另外设置行属于宿主机平面，因为设置命名空间是进程级单例。



</details>
