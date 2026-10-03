# 固定 Office 预览工作进程

此目录只提供 DOCX/XLSX/PPTX → PDF 的固定转换流程。Rust 主引擎仍负责任务、权限、停止、归属与缓存。它不接收用户脚本、任意文件路径或网络地址作为运行参数。

`worker.py` 在编译时嵌入 `crates/office`。Windows 小型启动器从应用自己的目录加载官方 LibreOffice 26.8.0 随附的 Python 3.13.15，固定模块和 DLL 搜索路径，关闭环境变量、用户模块与 site 初始化。当前初始化接口绑定该 Python 版本；升级到新版时需迁移至 PyConfig 并重复实际集成检查。

LibreOfficeKit 只负责启动不启用桌面实例通信的办公运行环境；文档加载、保存和关闭通过公开 UNO `AsyncCallback` 在其主线程执行，避免 Windows Calc 的跨线程窗口死锁。宏执行设置为 `NEVER_EXECUTE`，外部更新为 `NO_UPDATE`，隐藏、只读加载。PDF 保存完成后写入并同步结果，专用进程结束；不在宿主中加载 Office DLL。

引擎使用 Windows AppContainer：没有网络能力，只有转换器资源的读取权限和单次临时目录的写入权限。资源采用 `office-runtime/office` 两层目录，因为 LibreOffice 启动时需要枚举安装目录的直接父目录。授权只落在应用自己的外层目录，不授权项目目录或用户祖先目录。此系统边界在 macOS/Linux 尚未实现或验证。

准备：`npm run office:prepare`。该命令校验固定 SHA-256 的官方 MSI，在项目 `.local` 内解包，不全局安装；保留许可证、NOTICE、帮助资源、字体和附带的应用本地 C++ 运行库。标准 `npm run build` 会自动准备正式版本。清洁系统安装和体积精简仍属 P12。

验证：先用 `npm run test:media-engine` 生成办公样本，再运行 `npm run test:office-preview`；正式分发复测使用 `WORKPILOT_ENGINE_BINARY` 和 `WORKPILOT_OFFICE_TEST_OUTPUT`。`office_probe` 例子可验证实际隔离进程，附加 `--cancel` 会在进程启动后取消，不触碰其它进程。

上游依据：[LibreOffice 源码版本](https://github.com/LibreOffice/core/tree/bce0998afefdbc355585ca324285661a2170ba77)、[UNO 回调接口](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1awt_1_1XRequestCallback.html)、[CPython 3.13 初始化接口](https://docs.python.org/3.13/c-api/init.html)。办公组件原始二进制没有修改；运行包保留上游许可证，来源和逐文件摘要记录在运行环境清单。
