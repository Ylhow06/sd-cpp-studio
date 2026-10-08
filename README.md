# 本地生图工作台

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

基于 [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) 的本地图像生成前端：
一个**单文件 Web UI**（无构建步骤）+ 一个负责配置持久化的 **Node 小服务**。

> **本项目由 vibe coding 完成** —— 通过与 AI 结对开发（AI 生成 + 人工审阅、测试驱动）。
> 结构追求轻量实用，不引入框架与构建链。改动或使用前请先看文末「更多文档」。

硬件参考：Radeon 780M（Vulkan），Z-Image Turbo Q4_K，512×768 12 步采样约 1 分 30 秒 / 张。

---

## 快速开始

```bat
tools\serve.cmd
```

一条命令同时拉起两个进程并自动打开浏览器：

| 服务 | 端口 | 作用 |
|---|---|---|
| `sd-server.exe` | 1234 | 生图（stable-diffusion.cpp 的 HTTP 服务） |
| `serve-config.mjs` | 1235 | 配置读写（Node） |

停止：

```bat
tools\stop.cmd
```

### 命令行参数

```bat
tools\serve.cmd            :: Z-Image Turbo（默认，质量最好）
tools\serve.cmd sd15       :: SD 1.5（快，512px）
tools\serve.cmd z 1234     :: 指定端口
```

---

## 功能

| 模式 | 说明 |
|---|---|
| **文生图** | 标准出图，含预设提示词、比例快选 |
| **图生图** | 以已有图为起点，可调强度 |
| **局部重绘** | 画笔涂蒙版，只重画涂抹区域 |
| **批量** | 模板 + `{{占位符}}` 数组，一次出多张不重复组合 |

其他：历史记录、点击放大（滚轮缩放 / 拖动平移）、保存目录管理、在资源管理器打开目录、
**在终端跑批量任务（可关掉浏览器）**。

### 批量生图

模板里用 `{{名称}}` 做占位符，每张图独立随机取值：

```
服装：{{服装}}。场景：{{场景}}。
```

- 占位符名允许中文，**不能有空格**
- 同名占位符在同一张图内取**同一个值**（否则画面自相矛盾）
- 「跳过重复组合」开启时，张数不能超过组合总数
- 占位符没有对应数组 / 数组为空 / `{{` 未闭合 → 实时标红 + 点生成时硬拦

**模板库**：可存多套模板（模板 + 数组 + 张数 + 开关整套保存），支持
「使用 / 覆盖 / 改名 / 删除」，上限 20 套。使用前会自动备份当前内容，可一键撤回。

### 在终端跑批量（关掉浏览器也能继续）

批量面板底部「**在终端运行这一批**」：UI 把当前这一批的完整快照交给配置服务，
配置服务拉起一个终端跑 `tools\batch-run.mjs`，**这时候浏览器可以关掉**，生成照常进行。

按钮会告诉你接下来是「继续」还是「开新批」：有未完成批次且匹配时，
按钮变成「**🖥 继续（2/5）**」，旁边仍可开新批；否则就是开新批。状态条会明确提示。

> 这里的「继续 / 新批」是**终端脚本**的动作，和 UI 自己的批量续跑是两套独立进度。

```bat
:: 等价的手工调用（任务文件由按钮生成）
node tools\batch-run.mjs --job output\.cli-jobs\job_xxxxxx.json
:: UI 点「继续未完成批次」时任务文件带 mode:"resume"，等价于再加 --resume
```

终端脚本用法：

```bat
node tools\batch-run.mjs                      :: 用 config.json 的模板与张数（开新批）
node tools\batch-run.mjs --count 3 --w 128 --h 128 --steps 2
node tools\batch-run.mjs --resume             :: 续跑上次未完成批次
node tools\batch-run.mjs --list               :: 只打印计划，不出图
node tools\batch-run.mjs --out-dir D:\pics    :: 覆盖保存目录
node tools\batch-run.mjs --job <任务文件>      :: UI 下发的完整任务
node tools\batch-run.mjs --help
```

**断点续跑**：进度记在保存目录的 `.batch-cli-state.json`。默认总是开新批；
只有明确 `--resume`（或点「继续未完成批次」）才续跑，续跑按旧快照、改动提示词不丢失旧批次。

> **前提**：`sd-server` 和 `serve-config.mjs` 要活着（`tools\serve.cmd` 会一起拉起）。
> 关掉的是**浏览器**，不是这两个服务。

---

## 运行前提 / 依赖

- **Windows x64**（脚本是 `.cmd` / `.ps1`）
- 支持 Vulkan 的显卡（AMD 核显 / NVIDIA / Intel 均可）
- **Node.js**（只用于配置服务和测试，不参与生图）
- 模型文件：[模型安装](docs/模型安装.md)（Z-Image Turbo 三件套 或 SD 1.5）

`app\runtime\` 里是 stable-diffusion.cpp 的预编译产物，自带 MIT 许可证
（`ggml.txt`、`stable-diffusion.cpp.txt`）。

本项目源码以 **MIT License** 开源（见 `LICENSE`）。

---

## 更多文档

| 文档 | 内容 |
|---|---|
| [技术说明](docs/技术说明.md) | 技术选型与权衡、为什么用 sd-server、为什么 UI 是单文件、如何加接口 / 加测试 |
| [模型安装](docs/模型安装.md) | 装哪些模型、放哪、从哪下载、文件名硬要求 |
| [目录结构说明](docs/目录结构说明.md) | 目录组织、运行架构、配置服务接口、终端批量实现细节 |
| [批量生图模块-设计规格](docs/批量生图模块-设计规格.md) | 批量生图模块的完整设计规格 |
| [单文件 UI 协作指南](docs/单文件UI协作指南.md) | **Agent 版**：怎么安全改单文件 UI、命名 / 作用域 / 测试链路规则 |