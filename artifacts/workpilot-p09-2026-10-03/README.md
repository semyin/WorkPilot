# WorkPilot P09 开发预览

本版增加技能与插件管理，以及 WorkPilot 版内置 `skill-creator` 创建指导。实现和本机自动验证完成，待用户体验；不是完整正式版。

## 打开程序

先从旧版托盘彻底退出，再打开 [WorkPilot.exe](preview/WorkPilot.exe)。请保留整个 `preview` 文件夹，也可以使用 [Windows 预览压缩包](WorkPilot-P09-Windows-x64-preview.zip)。

顶部点击“技能与插件”，可以：

- 查看内置创建指导；用自己的模型准备创建任务，检查草稿后确认启用。
- 导入目录或 ZIP，先查看文件和权限，再安装。
- 检查外部工具、单独配置登录凭据、审批测试、查看完整结果。
- 停用、卸载、导出或回退历史版本。

附带 [报告检查技能](examples/report-checklist/SKILL.md)。导入其所在目录，选择一个绑定测试文件夹的执行任务并开启本地程序，再在资源区测试脚本；会生成 `report-checklist.md`，已有同名文件时保留原文件并报错。

## 验证与限制

本轮实际验证包含 Rust 引擎、本地受管理 Node 进程、两种 MCP 通信、本机 OAuth、真实 Windows 界面和独立分发目录。模型链路使用本机固定回复，实际生成质量及需要的商业服务登录仍待体验。

随包 Node.js 22.23.2。数据版本升级为 8；旧版不应打开升级后的数据。P00—P08 历史程序及清单保留。macOS/Linux、干净机器安装和完整迁移还未验收。

- [实现与使用边界](../../docs/development/P09-技能插件与创建流程.md)
- [完整验证记录](../../docs/development/P09-验证记录.md)
- [源码与程序摘要清单](source-and-binary-manifest.json)
- [引擎样本](evidence/extensions-engine.json)、[模型与技能流程](evidence/extensions-model.json)、[原生桌面](evidence/extensions-desktop.json)、[分发复测](evidence/distribution-desktop.json)
