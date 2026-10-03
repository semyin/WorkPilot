# WorkPilot

面向个人和小团队的通用 AI 桌面工作平台。采用自研 Rust 执行引擎、React/Tauri 2 桌面及独立工具进程。

当前接续 P12 技能与插件迁移：可批量选择当前安装版本和配套资源，口令加密备份，预览范围、依赖、权限及冲突后导入。导入项先停用，凭据重填并检查后手动启用。项目设置、记忆历史和文件历史备份继续可用；完整会话、项目文件、扩展旧版本/草稿、统一引用与版本清理仍待接续，P12 尚未整体验收。

P11 的确认记忆与本地定时能力保留：关窗继续，彻底退出后停止，错过不补跑，需要审批时等待用户。实际电脑睡眠、真实模型记忆质量、图片配置、用户体验和通知选择仍集中待确认。

- [开发计划与当前进度](docs/README.md)
- [P12 当前技能插件迁移预览](artifacts/workpilot-p12-extensions-2026-10-04/README.md)
- [P12 技能插件迁移说明](docs/development/P12-技能插件迁移.md)
- [P12 前一批记忆历史迁移预览](artifacts/workpilot-p12-memory-history-2026-10-04/README.md)
- [P12 前一批项目设置迁移预览](artifacts/workpilot-p12-settings-2026-10-04/README.md)
- [P12 项目设置迁移说明](docs/development/P12-项目设置迁移.md)
- [P12 前一批文件历史备份预览](artifacts/workpilot-p12-history-2026-10-04/README.md)
- [P12 历史备份与恢复设计](docs/development/P12-历史备份与恢复.md)
- [P12 前一批安装包和浏览器连接入口](artifacts/workpilot-p12-browser-setup-2026-10-04/README.md)
- [P12 首批安装与环境历史交付](artifacts/workpilot-p12-install-2026-10-03/README.md)
- [P12 安装与环境设计](docs/development/P12-安装与环境设计.md)
- [P12 真实验证与剩余项](docs/development/P12-验证记录.md)
- [P11 记忆与定时任务预览](artifacts/workpilot-p11-schedules-2026-10-03/README.md)
- [P11 定时设计与运行规则](docs/development/P11-定时设计.md)
- [P11 记忆开发预览](artifacts/workpilot-p11-memory-2026-10-03/README.md)
- [P11 记忆设计与接续边界](docs/development/P11-记忆设计.md)
- [P11 验证记录](docs/development/P11-验证记录.md)
- [P10 原版式预览补充版](artifacts/workpilot-p10-layout-2026-10-03/README.md)
- [P10 格式支持与边界](docs/development/P10-文件与图片设计.md)
- [P10 验证及真实图片待办](docs/development/P10-验证记录.md)
- [P10 首批历史预览](artifacts/workpilot-p10-2026-10-03/README.md)
- [P09 技能与插件预览](artifacts/workpilot-p09-2026-10-03/README.md)
- [P09 技能插件与创建流程](docs/development/P09-技能插件与创建流程.md)
- [P08 Windows 预览](artifacts/workpilot-p08-2026-10-03/README.md)
- [P08 浏览器设计与边界](docs/development/P08-浏览器双通道.md)
- [P08 验证与待授权体验](docs/development/P08-验证记录.md)
- [Companion 扩展安装与连接](extensions/companion/README.md)
- [P07 Windows 预览](artifacts/workpilot-p07-2026-10-03/README.md)
- [P07 文件历史与开发工作区](docs/development/P07-文件历史与开发工作区.md)
- [P07 验证与待体验项](docs/development/P07-验证记录.md)
- [P06 Windows 预览](artifacts/workpilot-p06-2026-10-02/README.md)
- [P06 工作台与记录](docs/development/P06-工作台与记录.md)
- [P06 验证与待体验项](docs/development/P06-验证记录.md)
- [P05 Windows 预览](artifacts/workpilot-p05-2026-10-02/README.md)
- [P05 调度与交付](docs/development/P05-多助手调度与交付.md)
- [P05 验证与待体验项](docs/development/P05-验证记录.md)
- [P04 Windows 预览](artifacts/workpilot-p04-2026-10-02/README.md)
- [P04 工具与审批边界](docs/development/P04-工具与审批边界.md)
- [P04 验证与待体验项](docs/development/P04-验证记录.md)
- [P03 Windows 预览](artifacts/workpilot-p03-2026-10-02/README.md)
- [P03 执行引擎与恢复](docs/development/P03-执行引擎与恢复.md)
- [P03 验证与剩余条件](docs/development/P03-验证记录.md)
- [P02 Windows 预览](artifacts/workpilot-p02-2026-10-02/README.md)
- [P02 模型配置和适配](docs/development/P02-模型配置与适配.md)
- [P02 验证与剩余条件](docs/development/P02-验证记录.md)
- [P01 数据模型与通信说明](docs/development/P01-数据模型与契约.md)
- [P01 开发与验证命令](docs/development/P01-开发与验证.md)
- [P01 Windows 预览](artifacts/workpilot-p01-2026-10-01/README.md)
- [P00 开发与验证命令](docs/development/P00-开发与验证.md)
- [P00 验证记录](docs/development/P00-验证记录.md)
- [随包环境调查](resources/runtimes/README.md)
- [浏览器扩展原型](extensions/browser/README.md)

```powershell
npm ci
npm run build
npm run check
```

开发窗口使用 npm run dev。先准备文档列出的 Rust 与系统构建依赖；以上命令从项目根目录执行。Windows 标准构建会准备并校验文档环境及办公转换器，首次下载和解包较大，运行资源约 1.58 GB。

代码维护遵守 [AGENTS.md](AGENTS.md)：单个代码文件最多 1000 行，包含空行和注释，按职责提前拆分。`npm run check:lines` 可单独检查，也已接入 `npm run check` 和远程检查；测试、脚本、样式及生成源码同样受检。

完整 P12 分发目录约 2 GB；安装包构建步骤见 P12 设计，不依赖旧预览程序包。历史备份与项目设置迁移已提交并推送 `d42e9d4`。随后进行代码拆分、行数约束维护、记忆历史和当前扩展迁移；这些接续修改仍在本地，结果见 [P12 验证记录](docs/development/P12-验证记录.md)。

仓库保留源代码、锁文件、文档、图标、调研样例和阶段验证证据。依赖、编译输出、本机数据、密钥及新生成的 WorkPilot 程序包由 `.gitignore` 排除；已生成的预览程序仍留在本机。新克隆仓库后需按上述命令构建，阶段文档中的程序包路径是本机交付位置，不是在线下载地址。旧提交中的程序包保留在历史中，本次不改写历史。

项目暂不公开发布。平台测试范围以阶段记录为准。
