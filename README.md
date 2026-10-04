# WorkPilot

面向个人和小团队的通用 AI 桌面工作平台。采用自研 Rust 执行引擎、React/Tauri 2 桌面及独立工具进程。

P12 已补齐统一资料迁移、多项目与文件夹映射、未决操作人工核对、技能旧版本与草稿、版本保留与数据清理、签名更新和失败恢复。Windows 分发包含专用 Chromium 浏览器及受限环境可用的 Git。干净系统、物理换机和用户实际体验仍须分别验收，当前不是已验收的正式 V1。

P11 的确认记忆与本地定时能力保留：关窗继续，彻底退出后停止，错过不补跑，需要审批时等待用户。通知已确定并实现软件内、Windows 系统和托盘三种渠道；实际电脑睡眠、系统提醒体验和用户验收继续单列。

最新开发预览 `0.1.0-alpha.13.4`、数据版本 11，正在 P13 最终集成检查：统一任务状态、接入三渠道通知与百炼真实图片，明确错误文件版本参数，补测真实模型、技能和记忆，并修正团队等待误提醒和通知设置竞态。设置页的完整迁移、数据清理、签名更新和单项备份继续可用。P12 已提交推送 `d20c5b2`；本轮 P13 改动仍在本地，正式 V1 尚未验收。

- [开发计划与当前进度](docs/README.md)
- [当前 P13 集成验证预览](artifacts/workpilot-p13-candidate-2026-10-04-r3/README.md)
- [P13 验收矩阵与待补条件](docs/development/P13-验收矩阵.md)
- [用户可以逐项体验的清单](docs/development/P13-用户体验清单.md)
- [原 P12 整合版与安装器](artifacts/workpilot-p12-complete-2026-10-04/README.md)
- [统一迁移与人工核对](docs/development/P12-统一迁移与人工核对.md)
- [签名更新与失败恢复](docs/development/P12-签名更新与恢复.md)
- [前一批文件历史随任务恢复预览](artifacts/workpilot-p12-history-restore-2026-10-04/README.md)
- [前一批附件随任务恢复预览](artifacts/workpilot-p12-attachment-restore-2026-10-04/README.md)
- [前一批多助手恢复预览](artifacts/workpilot-p12-team-restore-2026-10-04/README.md)
- [前一批单任务恢复预览](artifacts/workpilot-p12-task-restore-2026-10-04/README.md)
- [前一批办公预览与长目录修复版](artifacts/workpilot-p10-office-path-2026-10-04/README.md)
- [前一批任务与助手档案预览](artifacts/workpilot-p12-task-archive-2026-10-04/README.md)
- [任务与助手档案迁移说明](docs/development/P12-任务与助手档案迁移.md)
- [前一批 PDF 数字读取修复预览](artifacts/workpilot-p10-pdf-text-2026-10-04/README.md)
- [P12 前一批附件与成果迁移预览](artifacts/workpilot-p12-media-2026-10-04/README.md)
- [P12 附件与成果迁移说明](docs/development/P12-附件与成果迁移.md)
- [P12 前一批项目文件迁移预览](artifacts/workpilot-p12-files-2026-10-04/README.md)
- [P12 项目文件迁移说明](docs/development/P12-项目文件迁移.md)
- [P12 前一批技能插件迁移预览](artifacts/workpilot-p12-extensions-2026-10-04/README.md)
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

完整分发包含 9 类运行组件；实际文件、体积、许可与摘要以本批清单为准。安装包构建步骤见 P12 设计，不依赖旧预览程序包。最近提交推送为 `d20c5b2`；后续 P13 新修改尚未提交推送，真实结果见 [P13 验证记录](docs/development/P13-验证记录.md)。

仓库保留源代码、锁文件、文档、图标、调研样例和阶段验证证据。依赖、编译输出、本机数据、密钥及新生成的 WorkPilot 程序包由 `.gitignore` 排除；已生成的预览程序仍留在本机。新克隆仓库后需按上述命令构建，阶段文档中的程序包路径是本机交付位置，不是在线下载地址。旧提交中的程序包保留在历史中，本次不改写历史。

项目暂不公开发布。平台测试范围以阶段记录为准。
