# P00 浏览器扩展验证

这是 Chrome / Edge 共用的最小原型，验证“浏览器扩展 ↔ 本机 Rust 程序”的通信，以及当前测试标签页的填写、点击和读取。它不接入模型，不读取登录信息，只允许操作 WorkPilot 本地样本页。

## Windows 准备

1. 在项目根目录运行 node scripts/prepare-browser-probe.mjs，构建本机桥接并生成当前电脑的清单。
2. 对要测试的浏览器运行 powershell -NoProfile -File scripts/register-browser-probe.ps1 -Browser chrome 或 -Browser edge。只注册当前用户的 WorkPilot 原型，不需要管理员权限。
3. 由用户在 chrome://extensions 或 edge://extensions 开启开发者模式，选择“加载已解压的扩展”，选择本目录。
4. 运行 npm run fixtures，打开输出地址下的 /page，例如 http://127.0.0.1:端口/page。
5. 点击 WorkPilot 扩展图标，点击“连接当前测试页并验证”。预期结果为 passed 和 Hello, WorkPilot，随后自动断开调试连接。
6. 两种浏览器分别重复，检查错误页被拒绝，断开后不再操控标签页。

这些浏览器侧权限由用户确认。不要复制浏览器用户目录、自动批准安全提示或把普通独立浏览器测试当作已登录通道测试。

## 清理

在浏览器扩展页面移除 WorkPilot Browser Probe。然后运行同一注册脚本并加 -Unregister；脚本只移除指向当前项目的 WorkPilot 原型注册。

## 边界

- 当前按钮触发一次固定验证，不是 P08 的完整工具接口。
- 原型验证的是与日常浏览器通信的路径。没有真实用户授权和浏览器运行记录时，不标记已登录通道通过。
- Rust 桥接只接受固定的 hello/probe/result/disconnect 消息，不暴露文件读写、命令执行或任意脚本。
- 同一个扩展公开密钥让开发扩展 ID 固定；它不是模型密钥或授权凭据。
- macOS/Linux 的主机注册位置与安装方式留给对应平台验证。
