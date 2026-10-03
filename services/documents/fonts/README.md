# 文档字体

WorkPilot 使用 Noto Sans CJK SC Regular 2.004 为新生成的 PDF 嵌入中文字体，也用于生成静态图表。

- [官方字体来源](https://github.com/notofonts/noto-cjk/blob/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf)
- 许可为 SIL Open Font License 1.1，全文随附于 `OFL.txt`。不修改字体、不单独销售字体。
- 字体文件不入库；`node scripts/prepare-documents.mjs` 下载并核对固定 SHA-256，正式构建会携带字体和许可，不要求用户安装系统字体。
- DOCX/PPTX 的编辑与外部显示仍由办公软件及其可用字体决定；这里的 PDF 字体支持不等于所有办公软件的排版一致。
