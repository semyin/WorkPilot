# 密码 PDF 测试样本

`password-protected.pdf` 由本项目固定测试数据生成，内容为“WorkPilot 中文验收”和 25 + 17 = 42。使用 LibreOffice 26.8.0 设置打开密码，属于真正加密的 PDF，供引擎验证“需要密码”错误，避免测试依赖之前的本机运行产物。

重建方法见 `scripts/media-office-test.mjs`；密码只是该脚本里的固定测试文字，不是用户凭据。此文件只用于自动测试，不随文档处理器发布。
