# WorkPilot

面向个人和小团队的通用 AI 桌面工作平台。采用自研 Rust 执行引擎、React/Tauri 2 桌面和 SQLite 本地存储，支持模型接入、工具执行、多助手、浏览器、文件、技能与定时任务。

当前交付 `0.1.0-alpha.13.4` 作为功能验证版保留。根据 2026-10-09 用户反馈，工作台的布局、操作流程与整体产品体验尚未完成；当前回到 P06 产品化重做，P13 正式验收尚未开始。已有功能和自动验证是基础，不代表产品已经成熟。

- [开发计划与当前进度](docs/README.md)
- [工作台改版提案（示例数据）](artifacts/workpilot-product-design-2026-10-09/index.html)
- [新版工作台的实际接入与边界](docs/development/P06-工作台与记录.md#第一批正式接入2026-10-09)
- [当前候选版使用说明](artifacts/workpilot-p13-candidate-2026-10-04-r3/README.md)
- [验收矩阵](docs/development/P13-验收矩阵.md) · [用户体验清单](docs/development/P13-用户体验清单.md)
- [开发约定](AGENTS.md) · [构建环境准备](docs/development/P00-开发与验证.md)
- [安装与环境打包](docs/development/P12-安装与环境设计.md) · [随包组件与许可](resources/runtimes/README.md)

从项目根目录执行：

```powershell
npm ci
npm run dev
npm run check
npm run build
```

`dev` 打开开发窗口，`check` 执行常规检查，`build` 构建程序，三条命令按需要分别运行。先准备文档列出的 Rust 和系统构建依赖；Windows 首次构建会下载较大的文档及办公运行环境。

单个代码文件最多 1000 行，包含空行和注释。`npm run check:lines` 可单独检查，也已接入常规检查和远程流水线。

仓库保存源码、锁文件、文档、图标和验证证据。依赖、构建输出、本机数据、密钥及安装包不提交。阶段文档中的程序包路径是本机交付位置，新克隆仓库需自行构建；历史交付及其证据保持封存。旧版本专用打包脚本已移除，当前交付沿用 `package:p13` / `bundle:p13`，下一版本须先分配独立版本号与交付目录。

项目暂不公开发布。完整设计和历史验证入口统一在文档索引中维护。
