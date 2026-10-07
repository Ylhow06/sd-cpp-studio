# 上游组件说明

本目录下的二进制来自 **stable-diffusion.cpp** 的预编译发行版，不是本项目编写的代码。

## 文件

| 文件 | 作用 |
|---|---|
| `sd-server.exe` | 生图服务（HTTP API），本项目唯一调用的入口 |
| `stable-diffusion.dll` | sd.cpp 主体 |
| `ggml.dll` / `ggml-base.dll` | ggml 运行时 |
| `ggml-vulkan.dll` | Vulkan 后端（本机走这条，约 40 MB） |
| `ggml-cpu-*.dll` | 各代 CPU 指令集优化版（按 CPU 自动挑选，无需手动指定） |
| `libwebp.dll` / `libwebpmux.dll` / `libsharpyuv.dll` | WebP 编解码 |
| `webm.dll` | WebM 封装（视频输出用） |
| `ggml.txt` | ggml 的 MIT 许可证 |
| `stable-diffusion.cpp.txt` | stable-diffusion.cpp 的 MIT 许可证 |

## 为什么全部堆在一个目录

Windows 按**可执行文件所在目录**查找依赖 dll。
`sd-server.exe` 启动时会在这里找 `stable-diffusion.dll` 和 `ggml-*.dll`，
所以**不能把这些细分到子目录**。

那批 `ggml-cpu-*.dll` 看着多余（覆盖了从 sandybridge 到 alderlake 的各代 CPU），
但 sd.cpp 是按运行时的 CPU 特性**动态挑选**的，删掉不用的那些理论上可行，
升级版本时又要补回来——留着省事，一共才 8 MB。

`ggml-vulkan.dll` 是大头（40 MB），本机实际用的就是它。

## 重新获取

从 stable-diffusion.cpp 的 Releases 下载 Windows 版压缩包，解压后把这些文件
覆盖到本目录即可。**升级前建议先备份整个 `runtime\`**。

## 注意

- `sd-cli.exe` 已移除。它是命令行单张出图工具，本项目改用 `sd-server.exe`
  的 HTTP 模式后就没有调用方了。
- 本目录已被 `.gitignore` 排除（体积大且可重新下载）。
