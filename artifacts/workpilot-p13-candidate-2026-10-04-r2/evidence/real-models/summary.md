当前版本为 **0.1.0-alpha.13.3**。以下均使用真实服务和独立测试目录；失败样本仍保留，没有改成通过。

| 检查范围 | 实际结果 | 证据 |
|---|---|---|
| Qwen 三种接口的工具提案、文件读写回读与成果登记 | 6 项通过，实际写入 37 | [当前协议报告](format-initial.json) |
| DeepSeek 工具提案 | 通过 | [当前协议报告](format-initial.json) |
| 两种模型分工合作 | Qwen、DeepSeek 共三个成员，实际产出 42、48、90；依赖顺序、主任务检查、接受与回读均核对 | [团队报告](team-two-families.json) |
| 技能与记忆 | 7 项通过：模型读取内置 skill-creator、写草稿、提出候选、确认前后可见性、真实复用、跨项目隔离、删除后不可见且保留已有产物 | [工作流报告](skills-memory.json)、[核对说明](skills-review.json) |

协作样本实际使用 **两个模型家族、三个成员、两个协议**（Chat Completions 和 Responses）。主助手原文误称“三模型/三种协议”，已保留并[单独纠正](parent-summary-correction.json)。Messages 属于独立文件测试。通过判据来自实际调用、文件和检查记录。

GLM 的默认工具探针未提出调用；[单独澄清后的提案成功](glm-proposal-followup.json)，但实际新建文件仍连续返回错误参数。这次团队在 16 分钟上限停止，没有产出 a.txt/answer.txt，不能算文件兼容通过。当前新提示明确指出格式错误且拒绝执行；另一次成功的 Qwen 团队成员据此纠正了参数，见[实际纠正记录](format-recovery-observation.json)。不能据此保证所有模型都能纠正。

技能确认、记忆确认、精确文件审批、删记忆、卸载技能共五次操作由测试驱动独立管理入口执行，均逐项记录。这不等于模型自行批准，也不代表用户已经亲自体验。生成的[技能说明](created-SKILL.md)、[格式说明](created-format.md)和[实际报告](generated-summary.txt)已阅读；只验证简单整数样本，不扩大为所有生成质量。

初轮规划模式在 update_plan 后正确暂停，未完成草稿，保留在[原报告](skills-planning-initial.json)。alpha13.2 历史证据仅在 [history-alpha13.2](history-alpha13.2/run.json)，没有沿用为当前版本通过。各运行的凭据清理和明文扫描均通过，交付未复制数据库或凭据。完整步骤、请求与返回保存于对应 all-steps.json.gz；汇总见 [run.json](run.json)。
