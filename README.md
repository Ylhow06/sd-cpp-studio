# 本地生图工作台

基于 [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) 的本地图像生成前端。
核心是一个**单文件 Web UI**（无构建步骤）+ 一个负责配置持久化的 **Node 小服务**。

硬件参考：Radeon 780M（Vulkan），Z-Image Turbo Q4_K，512×768 约 40 秒 / 张。

---

## 快速开始

```bat
tools\serve.cmd
```

会同时拉起两个进程，然后自动打开浏览器：

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

其他：历史记录、点击放大（滚轮缩放 / 拖动平移）、保存目录管理、在资源管理器打开目录。

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

---

## 目录结构

```
.
├── app\                    程序本体
│   ├── ui\index.html       单文件 UI（全部前端逻辑都在这里，无构建）
│   ├── ui\config.json      运行时生成的配置（首次启动自动创建）
│   ├── models\             模型文件
│   └── runtime\            sd-server.exe 及其依赖的 dll
│                           注意：exe 与 dll 必须同目录，不要拆开
├── tools\                  启动 / 停止脚本
├── config-service\         配置服务（Node，可单独复用）
├── tests\                  测试（见下）
└── docs\                   设计与结构说明
```

### 为什么 exe 和 dll 单独放 `runtime\`

Windows 按**可执行文件所在目录**查找依赖的 dll。所以 `sd-server.exe` 与
`ggml-*.dll` / `stable-diffusion.dll` / `libwebp*.dll` 必须待在一起。
把它们和模型、脚本分开，只是为了让根目录清爽，不影响加载。

### 整体搬移

**所有路径都是从脚本自身位置推导的**，所以整个目录可以随意改名、移动、换盘，
不需要改任何代码。

```bat
:: 搬到别处后照常启动
<新路径>\tools\serve.cmd
```

唯一例外：`app\ui\config.json` 里的 `saveDir`（图片保存目录）是**绝对路径**，
与工程位置无关，搬移不受影响。

---

## 测试

```bat
node tests\test-xxx.mjs
```

**从任何工作目录执行都可以**（路径基于脚本自身位置推导，不依赖 cwd）。

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `test-slot-engine.mjs` | 29 | 占位符扫描与组合数计算（纯逻辑） |
| `test-dom-refs.mjs` | 23 | DOM id 引用一致性、启动默认值、标签闭合 |
| `test-e2e-jsdom.mjs` | 93 | jsdom 加载真实页面跑端到端 |
| `test-batch-strip.mjs` | 35 | 缩略图条点击与折叠 |
| `test-open-dir-ui.mjs` | 79 | 打开目录的前端流程 |
| `test-tpl-lib.mjs` | 84 | 模板库增删改查与覆盖 |
| `test-lightbox.mjs` | 50 | 点击放大 + 主图自适应 |
| `test-contain-geometry.mjs` | 54 | 各种宽高比的缩放几何 |
| `test-open-dir.mjs` | 62 | 配置服务接口与安全（**需先起服务**） |

前 8 套离线即可运行。最后一需要先启动配置服务：

```bat
node config-service\serve-config.mjs 1247
node tests\test-open-dir.mjs 1247
```

### 测试不碰你的配置

测试用 `SDCFG_PATH` 环境变量指向**临时文件**，并在随机高位端口起自己的服务，
所以不会读写 `app\ui\config.json`，也不用抢 1235 端口。

### 为什么用 jsdom 而不是真浏览器

本机沙箱禁止命名管道，Chromium/Edge 的 mojo IPC 直接失败，CDP 起不来。
jsdom 在 Node 进程内构造 DOM，能覆盖除渲染外的全部逻辑。
**代价**：jsdom 不做真实布局，所以 CSS 的视觉效果无法用测试验证，
只能验证 CSS 规则本身是否符合预期（见 `test-lightbox.mjs` 的断言写法）。

---

## 依赖

- **Node.js**（只用于配置服务和测试，不参与生图）
- Windows x64（脚本是 `.cmd` / `.ps1`）
- 支持 Vulkan 的显卡

`app\runtime\` 里是 stable-diffusion.cpp 的预编译产物，各自附带了 MIT 许可证
（`ggml.txt`、`stable-diffusion.cpp.txt`）。
