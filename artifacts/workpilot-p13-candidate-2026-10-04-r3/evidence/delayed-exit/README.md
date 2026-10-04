# 延迟退出记录：用户确认更正

用户已明确确认，2026-10-04 **22:43（北京时间）** 的两个旁观测试实例，是其手动退出或结束的。此项记录标为 `manual_user_exit_confirmed`。确认仅限本次22:43，不推断更早22:12那次退出。

[用户确认记录](manual-user-exit-confirmation.json)补充于原始证据之后；[原始失败报告](initial-observation/report.json)和逐秒日志均未覆盖。此次完整 installed-desktop-smoke 仍因测试脚本的中文路径输出编码错误而未启动，不能改为通过。此前独立 r3 [安装界面检查5组](../installation/desktop/report.json)已通过，作为不同样本保留。

[最终清理核对](final-cleanup.json)确认：18个记录中的自有桌面、引擎和WebView进程均已退出，采样程序已正常结束；本次安装的程序和注册项已移除，测试项目和约定保留的文件仍在。未重启原用户程序。

停止继续排查NSIS或增加样本。用户已取消四小时测试，本子任务结束，交回主任务完成最终核验。
