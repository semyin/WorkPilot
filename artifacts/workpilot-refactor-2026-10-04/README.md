# WorkPilot 代码拆分与行数约束验证

日期：2026-10-04；平台：Windows 11 Home x64 开发机。

前序文件历史与项目设置迁移已提交并推送 `d42e9d4`。此目录记录之后的代码维护：8 个超长源码按职责拆分，308 个代码文件全部不超过 1000 行，当前最长 984 行。具体范围、自动检查规则见 [AGENTS.md](../../AGENTS.md)。

- [行数及拆分前后清单](evidence/code-lines.json)
- [基础检查](evidence/standard-check.txt) 与 [最终界面/规则检查](evidence/final-source-check.txt)
- [实际构建](evidence/build.txt) 与 [程序摘要](evidence/build-receipt.json)
- [12 套实际流程检查](evidence/regression-run-all.json)：55 组引擎、36 组原生桌面检查通过
- [源码快照与验证汇总](evidence/summary.json)
- [阶段记录和边界](../../docs/development/P12-验证记录.md)

130 项 Rust 测试、11 项 Node 测试通过；2 项环境专用 Rust 检查仍按原配置忽略。此次构建保留程序版本 `0.1.0-alpha.12.3` 和数据版本 11，没有新做安装包或覆盖原有预览。重构后的本机可执行文件位于 `target/release/workpilot-desktop.exe`，不是独立分发包；原有历史/设置迁移预览继续保留。

本轮验证使用本地模型响应样本以及真实文件、进程、数据库和 Windows 桌面。没有重新验收真实云端模型、日常浏览器授权、安装升级或 macOS/Linux。P12 继续保持进行中；代码维护不能替代未完成功能和用户体验验收。本轮整理尚未再次提交推送。
