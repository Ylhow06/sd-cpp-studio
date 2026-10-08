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

批量面板底部有「**在终端运行这一批**」按钮。点了之后：

1. UI 把当前这一批的**完整快照**（模板 + 数组 + 张数 + 尺寸 / 步数 / CFG /
   采样器 / 反向提示词 / 种子 + 保存目录）交给配置服务；
2. 配置服务把它写成任务文件，再拉起一个终端窗口跑
   `tools\batch-run.mjs`；
3. **此时浏览器可以关掉**，生成照常进行。

**按钮会告诉你它接下来是「继续」还是「新批」**：
UI 会探测保存目录里有没有**未完成批次**。有且和当前模板/张数匹配时，
按钮自动变成「**🖥 继续未完成批次（2/5）**」，旁边仍可开新批；
没有匹配的旧批次时，按钮是「在终端运行这一批」（= 开新批）。
状态条会显示「有未完成批次可续（2/5）」或「上次批次已完成」等，不会让你猜。

注意：这里说的「继续/新批」只是**终端脚本**的动作；它和 UI 自己的
批量计划（冻结快照中的「续跑/开始新批次」）是两套独立的进度，互不影响。

```bat
:: 等价的手工调用（任务文件由按钮生成）
node tools\batch-run.mjs --job output\.cli-jobs\job_xxxxxx.json
:: UI 点「继续未完成批次」时，任务文件里带 mode:"resume"，等价于再加 --resume
```

**为什么不能让终端自己读 `config.json`**：那个文件只存模板 / 数组 / 张数 /
保存目录 —— 尺寸、步数、CFG、反向提示词**只在浏览器内存里**，从来没落过盘。
所以必须由 UI 把这份快照显式传过去，否则终端会用脚本的默认值出图，
比例和反向提示词全丢。

**断点续跑**：进度记在保存目录的 `.batch-cli-state.json`（v2 快照，含完整模板 /
数组 / 参数 / 反向提示词）。默认**总是开新批**；只有明确加 `--resume`（或 UI 里点
「继续未完成批次」）才续跑。**续跑按旧快照进行，与你后来改的提示词/参数无关** ——
改了照样能找到旧批次续跑，不会重烧已出的图。只要检测到未完成批次，无论续不续
都会**明确提示**，不会闷头开新批。

#### 终端脚本用法

```bat
node tools\batch-run.mjs                      :: 用 config.json 的模板与张数（开新批）
node tools\batch-run.mjs --count 3 --w 128 --h 128 --steps 2
node tools\batch-run.mjs --resume             :: 续跑上次未完成批次
node tools\batch-run.mjs --list               :: 只打印计划，不出图
node tools\batch-run.mjs --out-dir D:\pics    :: 覆盖保存目录
node tools\batch-run.mjs --job <任务文件>      :: UI 下发的完整任务
node tools\batch-run.mjs --help
```

常用选项：`--count` `--w` `--h` `--steps` `--cfg` `--sampler` `--scheduler`
`--neg` `--seed` `--out-dir` `--server` `--config` `--job` `--list` `--resume`。
**命令行显式给的参数优先于 `--job` 里的值**，方便临时覆盖。
（旧版 `--new` 仍可用，但现在默认就是开新批，它只是向后兼容空开关。）

**终端打印的是标签，不是提示词**：每张只列出各占位符**选中的值取前 5 个字**，
超长补 `…`，按槽对齐。这样一屏就能看出这批在覆盖哪片组合空间，
而不是被几百字的提示词刷屏。出图用的**仍然是完整提示词**（PNG 元数据里也是完整的），
标签只影响终端显示：

```text
        发型        · 氛围        · 饰品        · 场景        · 动作
  [待生成] 01. 20261007_235649_t2i_01_seed567084430.png
        黑色长发波… · 黄昏柔光，… · 只穿一双带… · 柔光下的双… · 正面直立站…
```

> **前提**：`sd-server` 和 `serve-config.mjs` 要活着（`tools\serve.cmd` 会一起拉起）。
> 关掉的是**浏览器**，不是这两个服务。
> 生图走的是 sd-server 的 HTTP 接口，**模型只加载一次**，每张不会重新载入。

#### 为什么不直接用 `sd-cli.exe`

`app\runtime\` 里有 `sd-cli.exe`（命令行单张出图），实测结论是**不适合批量**：

| | sd-cli.exe | sd-server + HTTP（本脚本采用） |
|---|---|---|
| 模型加载 | **每张重载 1~2.5 秒** | 常驻，只加载一次 |
| 输出目录不存在 | **静默失败，退出码仍为 0** | 不存在此问题 |
| 进度查询 | 只能解析 stderr | 有 `jobs/{id}` 接口 |
| 提示词 | 中文要写文件绕转义 | JSON 直传 |

最坑的是第一条里的第二行：`sd-cli.exe` 写文件失败时**退出码依然是 0**，
只在日志里留一行 `(failure)` / `0/1 images saved`。
如果按退出码写驱动脚本，会安静地丢掉整批图。

> 顺带记录：`-b N`（batch-count）对批量生图**没用** —— 它只递增 seed，
> 提示词是同一个。批量要的是每张不同提示词，只能每张一次请求。
> 另外 `sd-cli.exe` 在 512×512 时 `-b 2` 曾报 `ErrorOutOfDeviceMemory`，
> 而 `-b 4` 反而成功，显存边界不稳，别贪。

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
├── tools\                  启动 / 停止脚本 + 终端批量脚本
│   ├── serve.ps1           启动器（真正干活的）
│   ├── serve.cmd           双击入口
│   ├── stop.cmd            停掉 sd-server
│   └── batch-run.mjs       终端批量生图（可关掉浏览器）
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
| `test-lazy-sampler.mjs` | 21 | 惰性洗牌采样器：抽满不重不漏、卡方均匀性、续跑重建、稀疏性 |
| `test-dom-refs.mjs` | 23 | DOM id 引用一致性、启动默认值、标签闭合 |
| `test-e2e-jsdom.mjs` | 102 | jsdom 加载真实页面跑端到端（含百万级组合空间性能回归） |
| `test-batch-strip.mjs` | 35 | 缩略图条点击与折叠 |
| `test-open-dir-ui.mjs` | 79 | 打开目录的前端流程 |
| `test-tpl-lib.mjs` | 84 | 模板库增删改查与覆盖 |
| `test-lightbox.mjs` | 50 | 点击放大 + 主图自适应 |
| `test-contain-geometry.mjs` | 54 | 各种宽高比的缩放几何 |
| `test-open-dir.mjs` | 62 | 配置服务接口与安全（**需先起服务**） |

前 9 套离线即可运行。最后一套需要先启动配置服务：

```bat
node config-service\serve-config.mjs 1247
node tests\test-open-dir.mjs 1247
```

### 离线测试需要 jsdom

6 套 jsdom 测试（`test-e2e-jsdom` / `test-batch-strip` / `test-open-dir-ui` /
`test-tpl-lib` / `test-lightbox`）从 `%TEMP%\sdjsdom\node_modules\jsdom` 加载 jsdom。
缺失时先装一次：

```bat
npm install jsdom --prefix %TEMP%\sdjsdom
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
