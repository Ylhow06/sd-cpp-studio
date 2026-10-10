# 单文件 UI 协作指南（Agent 版）

> 本工程的 UI 是**单文件**：前端全部逻辑都在 `app/ui/index.html` 内联的
> 一个 `<script>` 里，无构建、无打包。这个结构是 sd-server 的硬约束
> （`--serve-html-path` 只把**一个** HTML 文件在内存里 serve 到 `/`，
> 不提供任何静态资源路由，所以 `<script src="...">` 外部脚本会 404 白屏）。
>
> 如果你（一个 coding agent）被派来改这个 UI，请先读本文 —— 下面是
> 维护者踩过的坑和既定规则。**先看懂约束再动手，别把单文件拆了。**

---

## 0. 为什么必须保持单文件（先别拆）

- sd-server 通过 `--serve-html-path app\ui\index.html` 把该文件读进内存、
  只在根路径 `/` 返回。
- **不注册任何静态资源路由**。你把 `<script>` 拆成外部 `script.js`，
  浏览器请求 `/script.js` 会 404，UI 直接白屏。
- 所以「把内联脚本抽成 `.js` 文件」**不可行**，无论走经典 `<script src>`
  还是 `<script type="module">`。改动必须在同一个 HTML 文件内完成。

如果你觉得这段结构该重构 —— 那属于「换部署拓扑」级别的改动
（比如自己起一个能 serve 目录的静态服务，把 sd-server 当纯 API），
**别顺手做**，先向维护者提出，单独讨论，不要内联在功能改动里。

---

## 1. 脚本块在哪一行、用哪个语法

- 全文件唯一一个 `<script>` 是传统（经典）内联脚本：
  ```html
  <script>
    /* ... 全部前端逻辑 ... */
  </script>
  </body>
  </html>
  ```
- 顶层用 `const` / `let` / `function` 声明的都落在**页面全局词法作用域**，
  不是 `window` 属性。jsdom 测试靠 `window.eval` 访问这些名字
  （见 §3）。
- **不要**为了「现代感」把 `<script>` 改成 `<script type="module">`。
  模块顶层 `const` 是 `window.eval` 访问不到的，会劝退整条测试链路
  （9 个测试套件），且对运行无任何收益。保持经典脚本。

---

## 2. 全局命名空间是共享的：别重名

整个 `<script>` 里所有顶层 `const` / `let` / `function` 共用**一个**作用域，
没有任何模块边界。这是最大的雷区。

历史上真实翻车：有人在页面初始化段又声明了一个 `const cn`，而批量功能里
早就有个 `cn`（count 元素），导致「同名变量在同一个函数里被覆盖」，
只在特定路径触发、测试都难定位。最后靠 `node --check` + 全局搜索才揪出来。

**规则**：
- 新增任何顶层标识符前，先全局搜索 `index.html` 确认**没被用过**。
- `const cn`、`const $`、`function init`、`let data` 这类**通用短名极度危险**，
  自己起的名字最好带业务前缀（`cliInfo`、`batchTpl`、`pdList`…）。
- 同一个 `<script>` 内旧代码为了省事会重用 `const cn`/`const g` 等，
  你**不要跟着往下叠**，用新名字。

---

## 3. jsdom 测试如何读页面逻辑（改动别破坏它）

jsdom 测试（`tests/test-e2e-jsdom.mjs`、`test-tpl-lib.mjs`、
`test-batch-strip.mjs`、`test-open-dir-ui.mjs`、`test-lightbox.mjs`、
`test-slot-dlg.mjs`、`test-cli-mode-ui.mjs`）用
`new JSDOM(html, { runScripts:'dangerously', ... })` 真实加载整个 HTML，
然后靠 `window.eval(...)` 在页面词法作用域里执行/取值。

它们统一从 `tests/harness.mjs` 取 `loadJsdom()` 与 `UI_HTML`
（jsdom 走仓库根的 `npm install`，不再从 `%TEMP%\sdjsdom` 加载）。

对应的两条硬规则：

1. **顶层 `const`/`let` 别改成 `var` 也别塞进闭包**（否则 `window.eval` 读不到）。
2. **页面启动逻辑（`boot()` / IIFE 初始化）必须能无头跑完**：
   jsdom 里没有真 fetch、真 canvas、真 indexedDB，测试用
   `beforeParse` 里的桩顶替。你新增的初始化代码如果**在没有任何用户交互
   时就触发网络请求 / 访问 DOM 之外的东西**，会让所有 jsdom 套件启动即崩。
   不确定就先跑一遍 `node tests/test-e2e-jsdom.mjs`。

3. **新增测试文件**：放 `tests/` 下、以 `test-` 开头即可被 `npm test` 发现
   （`harness.mjs` 不以 `test-` 开头，天然不会被当测试跑）。
   需要配置服务就用 `startIsolatedService()`，需要 jsdom 就用 `loadJsdom()`，
   别自己拼 `%TEMP%` 路径、别写死端口。

---

## 4. 改动的正确姿势

1. **先在 `app/ui/index.html` 里全局搜索**你要新增/修改的标识符和 DOM id，
   确认没撞已有定义。
2. 改完 JS 后，先做语法体检（PowerShell 下把脚本抠出来 `node --check`，
   注意用 UTF-8 **无 BOM** 写临时文件，否则 JSON/脚本可能带不可见字符）：
   ```powershell
   $h = Get-Content app\ui\index.html -Raw -Encoding UTF8
   $s = $h.Substring($h.IndexOf('<script>')+8, $h.LastIndexOf('</script>') - ($h.IndexOf('<script>')+8))
   $enc = New-Object System.Text.UTF8Encoding($false)
   [System.IO.File]::WriteAllText("$env:TEMP\ui-check.js", $s, $enc)
   node --check "$env:TEMP\ui-check.js"
   Remove-Item "$env:TEMP\ui-check.js" -Force
   ```
   （别用 `Set-Content -Encoding utf8`：它在 PowerShell 5.1 会写带 BOM 的文件，
   也可能不认 `utf8NoBOM` 枚举。）
   有「变量未被定义」「括号不配对」这类**不会立刻炸在浏览器但会让
   `window.eval` 出问题**的错，这里就能先拦住。
3. 跑对应的 jsdom 套件（§5）。**不要只跑 linter**，jsdom 端到端才覆盖
   启动与交互路径。
4. 如果改了默认值（尺寸 / 步数 / 标签文案 / 张数），同步检查
   `tests/test-dom-refs.mjs` —— 它断言了「静态 HTML 标签 / 默认值与脚本
   默认值一致」。只改脚本不改断言，测试会红。

---

## 5. 跑测试

**一条命令跑全部**（推荐）：

```bat
npm install        :: 首次一次即可，装 jsdom
npm test           :: 15 个测试文件，约 65 秒
```

每个测试**自带隔离环境**：自己起一个「临时配置 + 临时模板库 + 内核分配的空闲端口」
的配置服务，跑完自己关。所以：

- **不需要**预先起服务，**不需要**手动传端口
- 绝不碰 `app\ui\config.json` 与 `app\ui\templates\`
- 测试模式下服务带 `SDCFG_NO_OPEN=1`：`/open-dir` 校验照走，但**不真的弹资源管理器窗口**
  （否则跑一轮会攒下一堆文件夹窗口）

单个测试也可以直接跑，无需任何前置步骤：

```bat
node tests\test-slot-engine.mjs     :: 占位符引擎（纯逻辑，最快）
node tests\test-e2e-jsdom.mjs       :: DOM 端到端
node tests\test-slot-dlg.mjs        :: 占位符取值弹窗
node tests\test-open-dir.mjs        :: 配置服务接口 + 安全边界
```

> 改 UI 时至少跑 `test-dom-refs.mjs`（静态一致性）+ `test-e2e-jsdom.mjs`（端到端）。

### 测试不许依赖个人数据

**硬约束**：测试不得依赖你本机特有的东西 —— 个人模板库里的某个模板、
某个固定端口、某个固定盘符路径、`%TEMP%` 里手装的 jsdom。

反面教材（已修）：`test-slot-dlg.mjs` 曾要求模板库里存在
`tpl_muwcqto6_skirt_full`，没有就**静默跳过整节** —— 于是别人跑出 114 项、
你本机跑出 123 项，那一节等于白写。现在它自己在隔离模板库里写一个固定装置模板。

需要「一个多槽模板」这类素材时，**自己造**（见 `test-slot-dlg.mjs` 的 `FIXTURE_TPL`），
不要去读用户模板库。

---

## 6. 保持硬约束小结（改完自查清单）

| 检查 | 违规后果 |
|---|---|
| 仍是单个内联 `<script>`，没拆外部文件 / 没改 module | 外部脚本 404 / 测试全崩 |
| 新增顶层变量无重名 | 定义覆盖 → 隐蔽 bug |
| 顶层 `const`/`let` 保持全局词法作用域 | `window.eval` 读不到 → 测试崩 |
| 启动逻辑在无网络/无 canvas 环境下也能跑完 | jsdom 套件启动即崩 |
| 默认值改动已同步 `test-dom-refs.mjs` | 静态一致性断言红 |
| 全量 jsdom 套件通过 | 交互回归没覆盖 |

---

## 7. 想加新界面 / 新功能时

- **结构上**照抄现有「一个 `data-pane` + 一组 `data-f` 字段」的写法，
  状态统一放 `S.m.<mode>`，界面刷新走现有 `syncLabels` / `loadPane` /
  `savePane` 约定（见 `docs\批量生图模块-设计规格.md`）。
- **名字上**照 §2，全局搜索后再定。
- **测试上**给 `test-e2e-jsdom.mjs` 加一段（它已经按 A/P/Q 分段，照格式追加）。