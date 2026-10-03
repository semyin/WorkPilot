# P10 实际生成样本

这里的 DOCX、XLSX、PPTX、PDF、CSV 和 Markdown 均由 WorkPilot 文档处理器生成，内容为固定测试数据：25 + 17 = 42。

DOCX、XLSX、PPTX 另外用独立 LibreOffice 打开，导出 PDF 后渲染成同目录的页面图片，核对中文、42、25/17 图表和两页演示。`pdf-page-1.png` 则由原 PDF 直接渲染，不是办公文件转换预览。

中文 PDF 当前完整嵌入开源字体，文件约 14 MB；这是避免字体子集缺字的已知体积代价，后续仍需优化。Office 原版式转换尚未集成进产品，本目录的验证页面不能代替内置预览功能。
