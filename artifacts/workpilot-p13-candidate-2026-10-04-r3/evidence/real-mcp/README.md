# 真实 Microsoft Learn MCP 验证

2026-10-04，Windows，WorkPilot 0.1.0-alpha.13.4。使用固定本地模型和真实微软公开服务；本次不调用收费模型、不使用账号。

最终独立样本 4 组通过。插件预览后由独立测试驱动确认启用，发现和查询再分别批准一次。批准前没有远端连接；批准后各建立一条原样转发的 TLS 连接，没有解密或替换证书。实际协商 2025-06-18，动态发现微软的资料搜索、资料读取和代码样例搜索三个工具。本次实际调用资料搜索，另外两个仅发现，不宣称已经调用。

查询主题为 Windows App SDK 通知注册与激活。工具返回公开文档片段及链接；完整内容保存在独立测试任务中，归档仅保存结果摘要、内容校验值和完整工具结构。超过 24,000 字节的结果由软件向模型提供记录引用，完整正文由独立测试驱动回读核对，因此不能声称固定模型阅读了全文。

- [最终报告](final/report.json)
- [当前完整工具结构](final/remote-tool-catalog.json)
- [连接记录](final/connect-audit.json)
- [结果摘要](final/remote-result-summary.json)
- [第一次测试驱动失败](initial-long-result/report.json)：误把大结果引用当作正文。
- [第二次测试驱动失败](initial-reference-comparison/report.json)：误要求两种序列化记录具有相同引用；[离线核对](initial-reference-comparison/offline-result-reference-check.json)证明实际 JSON 内容相同。
- [范围说明与原始报告措辞校正](scope-corrections.json)

两份失败报告保留原状，最终结果来自新的独立目录，不把早期样本改成通过。本次只验证一个无需登录的公开服务，不覆盖 OAuth、商业服务器、持久会话服务、真实模型推理或用户体验。测试期间存在另一项稳定性运行，以上耗时不作为正式性能数据。

微软官方说明该服务使用 Streamable HTTP、无需认证；工具结构应在每次初始化后发现。见[开发参考](https://learn.microsoft.com/en-us/training/support/mcp-developer-reference)和[服务说明](https://learn.microsoft.com/en-us/training/support/mcp)。
