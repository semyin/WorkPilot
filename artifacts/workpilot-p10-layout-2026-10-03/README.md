# WorkPilot P10 原版式预览补充版

日期：2026-10-03。Windows 开发预览，数据版本仍为 9。原 P10 程序和证据保留在相邻目录。

## 怎样查看

1. 从旧版 WorkPilot 的托盘菜单彻底退出。
2. 双击 [WorkPilot.exe](preview/WorkPilot.exe)，保留完整 `preview` 文件夹。
3. 在绑定文件夹的任务中打开“文件成果与图片”，读取 DOCX、XLSX 或 PPTX，点击“查看原版式预览”。
4. 可翻页、停止；外部编辑后点击刷新查看新版本。原来的附件快照仍可单独查看。

本机完整包：[Windows 预览压缩包](WorkPilot-P10-Windows-x64-preview.zip)。这是本地构建产物；Git 保存源码、说明、清单和证据，不上传程序及大体积运行环境。

## 本次变化

- Word、Excel 和 PPT 从实际原文件转换为页面，显示实际总页数；不再仅提供文字内容预览。
- 重复查看复用转换结果；新文件版本和旧快照分别缓存。
- 关闭面板或点击停止可取消预览。转换进程不能联网，宏与外部更新关闭，原文件不改写。
- 随包提供办公转换器，运行环境约 1.58 GB。字体与复杂排版可能和 Microsoft Office 有差异。

仍未完成：真实图片服务的生成/编辑验收、用户日常体验、干净机器安装和 macOS/Linux 实机。因此本版本不是正式 V1，也不表示 P10 已整体验收。

检查结果见 [P10 验证记录](../../docs/development/P10-验证记录.md)、[证据汇总](evidence/summary.json)；程序及源码摘要见 [交付清单](source-and-binary-manifest.json)。
