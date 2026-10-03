# WorkPilot

面向个人和小团队的通用 AI 桌面工作平台。采用自研 Rust 执行引擎、React/Tauri 2 桌面及独立工具进程。

当前交付 P07：在三栏工作台中加入项目文件编辑、修改历史与恢复、真实终端、所选 Git 提交和本机运行预览。实现、Windows 自动检查和独立分发复测完成，用户重点体验与通知方式集中待确认；下一步为 P08 浏览器双通道。

- [开发计划与当前进度](docs/README.md)
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

开发窗口使用 npm run dev。先准备文档列出的 Rust 与系统构建依赖；以上命令从项目根目录执行。

仓库保留源代码、锁文件、文档、图标、调研样例和阶段验证证据。依赖、编译输出、本机数据、密钥及新生成的 WorkPilot 程序包由 `.gitignore` 排除；已生成的预览程序仍留在本机。新克隆仓库后需按上述命令构建，阶段文档中的程序包路径是本机交付位置，不是在线下载地址。旧提交中的程序包保留在历史中，本次不改写历史。

项目暂不公开发布。平台测试范围以阶段记录为准。
