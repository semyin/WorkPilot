# Windows 受限 Git 路径兼容版

此组件以 GPL-2.0-only 分发。Git 上游及本目录的补丁、C 辅助文件共同构成修改版。完整 Git 与 zlib 原始源码压缩包、许可证和构建脚本放在随包 `git-runtime/sandbox/source`；已保留上游 Unix 链接的原始存档。

受限命令仍运行于原来的 Windows AppContainer，不添加网络能力、不扩大项目祖先目录读取、不启用进程外代执行。兼容版只修复两处路径处理：

1. Windows 在 AppContainer 中禁止查询 DOS 卷名。读取已经获准打开的文件句柄对应的 NT 路径，再用父进程提供的本地卷名称映射得到 DOS 路径。映射仅是字符串，没有传递额外文件句柄或访问能力。未知卷映射继续失败。
2. Git 创建目录时，先找到已经可访问的最近父目录，再逐级创建缺少的子目录。原来的创建、非目录冲突、共享权限和错误处理保留，不要求检查项目外的每一级祖先。

命令输入、审批、停止、进程树退出、文件历史和操作系统访问控制保持原规则。完全访问使用未修改的官方 MinGit。此兼容构建用于原本就禁网的受限命令，包含 Git 本地内置命令，使用静态 zlib/C 运行库；不包含 curl、PCRE2、gettext、Git Bash 或 Git LFS。普通 Git 的已安装第三方功能不因此成为首版内置承诺。

## 构建

维护者在 Windows x64 安装 Visual Studio 2022 C++ Build Tools（含 CMake/Ninja）、Git for Windows 和 Node 后，运行 `node scripts/prepare-git-sandbox.mjs`。下载输入与 SHA-256 固定在 `sources.json`；输出回执核对所有源码补丁、构建脚本及程序文件。包内用户运行不需要这些开发工具。

用随包源码重新构建时，以 `git-runtime/sandbox/source` 为工作目录。把两个源码压缩包复制到该目录下的 `.local/p12-runtime-downloads`，然后运行同一命令。脚本创建新的应用内构建目录，不修改全局 PATH 或用户 Git。

静态构建检查不允许依赖额外的 VCRUNTIME/MSVCP 或 C 运行库安装。源代码中的 Unix 链接在 Windows 构建树中按普通文本文件保留，提取时不建立文件系统链接；运行环境提取器仍拒绝链接。

依据：[Git for Windows 源码](https://github.com/git-for-windows/git/tree/v2.56.0.windows.1)、[Windows 路径 API](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)、[微软 STL 中的相同系统限制](https://github.com/microsoft/STL/issues/6286)。
