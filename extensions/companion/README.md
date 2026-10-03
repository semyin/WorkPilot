# WorkPilot Browser Companion（P08）

这是 P08 实现的日常 Chrome / Edge 连接通路，和 P00 Browser Probe 分开。不会复制用户的浏览器配置、Cookie 或登录资料，也不会自动控制其它已有标签页。

## 本机准备与安装

1. 在项目目录执行 node scripts/prepare-browser-companion.mjs。
2. 分别执行 powershell -NoProfile -File scripts/register-browser-companion.ps1 -Browser chrome，以及同一命令的 -Browser edge。只注册当前用户的新 Companion 主机，不改旧 Probe 注册，不需要管理员权限。
3. 用户在 chrome://extensions 或 edge://extensions 开启开发者模式，选择“加载已解压的扩展”，选择本目录。扩展名称为 WorkPilot Browser Companion，版本 0.8.0。
4. 在 WorkPilot 选择一个绑定项目文件夹的执行任务，打开右侧“浏览器工作区”，为对应日常浏览器生成连接码。
5. 在浏览器打开目标网页，点 Companion 图标，粘贴连接码，点击“连接当前标签页”。连接码十分钟有效，仅可使用一次；不要发给网站或其它人。
6. 返回 WorkPilot，选择已连接标签页。先读取页面，再点击、填写、截图、上传或下载。重新加载/变化后的页面必须重新读取；审批不会转移到其它页面。

本次连接授权当前标签页及其新建页面/弹窗，不包含其它既有标签页。页面读取使用固定的独立脚本；不提供任意脚本执行接口。上传读取经工作区核验的文件字节，下载直接保存到工作区，不复制登录数据库。

“手动接管”暂停自动操作；完成登录或验证后显式恢复。浏览器的“取消调试”、停用扩展、关闭标签页和退出 WorkPilot 都会收回连接，不自动重连，不重跑未确定的操作。退出 WorkPilot 不关闭日常浏览器。

## 测试和边界

自动测试只操作本地专用测试页，不进入真实账户执行外部业务。自动隔离配置的扩展测试不能代替用户在日常 Chrome / Edge 的实际授权验证。

普通安装版 Chrome、Edge 的侧载权限由浏览器和用户管理；不使用危险调试开关、策略修改或复制个人配置绕过安装授权。正式分发安装体验按 P12 完成；macOS/Linux 主机注册尚待对应平台实测。

清理：在浏览器扩展页面移除 Companion，再运行对应注册脚本并加 -Unregister。脚本只移除当前项目登记的新 Companion 主机，旧 Probe 保留。
