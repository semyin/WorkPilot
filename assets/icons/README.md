# WorkPilot 桌面图标

已采用用户确认的白底、石墨灰、银灰配色，圆润 W 与短导航箭头造型。

## 文件用途

| 文件 | 用途 |
|---|---|
| `icon.ico` | Windows 程序、安装包、桌面快捷方式图标 |
| `icon.png` | 1024×1024 透明 PNG，通用母版、应用内展示 |
| `icon.icns` | macOS 图标资源，包含普通与高分辨率表示 |
| `png/` | 16、20、24、32、40、48、64、128、256、512、1024 像素 PNG |
| `preview.png` | 浅色与深色背景上的实际尺寸预览 |
| `source/workpilot-approved.png` | 用户确认的原始生成图，1254×1254，原样保留 |
| `source/generation-prompt.txt` | 原图生成方式和最终编辑提示词 |

ICO 内含 16、20、24、32、40、48、64、128、256 九个尺寸。小尺寸使用带透明度的 32 位位图，256 尺寸使用 PNG 压缩。

图标外部透明、内部白色底板和造型均保留。PNG 按像素尺寸使用，不依赖 DPI 数字。全部缩放资源均直接从原图生成，不逐级缩小。

## 接入桌面程序

P00 已在 [Tauri 桌面配置](../../apps/desktop/src-tauri/tauri.conf.json) 中引用原有 ICO、ICNS 和 PNG；React 品牌区及 Windows 托盘沿用这些资源，没有重画用户确认的图标。Windows 程序已构建并运行，macOS/Linux 图标仍待对应平台实机检查。

正式安装器和快捷方式由 P12 接入，应用标识与快捷方式需保持一致。替换后仍显示旧图标时，先检查快捷方式与系统图标缓存。

如后续需要系统托盘，建议另做深浅色兼容的简化小图标；macOS 菜单栏可使用单色模板图。当前这套用于桌面应用图标。

## 验证范围

- 原图副本的 SHA-256 与用户确认的生成文件一致。
- 已检查 PNG 尺寸和透明度，以及浅色、深色背景的小尺寸预览。
- ICO 已通过 Windows System.Drawing.Icon 实际加载检查。
- ICNS 已进行文件结构检查；没有在 macOS 真机验证。
- 原图属于位图，没有提供或假称存在 SVG 矢量原稿。后续如需印刷或超大尺寸，可再制作矢量版本。

## 重新生成尺寸

在 Windows PowerShell 中，从项目根目录运行：

```powershell
./scripts/build-icons.ps1
```

该脚本使用 Windows 的 System.Drawing，无需额外安装 Python 包。只处理尺寸与封装格式，不重画用户确认的设计。

参考：[Microsoft 图标格式说明](https://learn.microsoft.com/en-us/windows/win32/menurc/about-icons)。
