---
name: report-checklist
description: 按清晰标题、事实核对、待办事项的顺序检查报告，并生成一个可复用的检查清单。
compatibility: 脚本需要 Node.js；可以只读说明，不运行脚本。
---

当用户要求检查报告或生成报告检查清单时使用本技能。

1. 按需读取 `references/checklist.md`。
2. 根据用户提供的报告指出缺少的事实，不编造数据。
3. 用户要求保存清单时，调用平台的技能脚本工具运行 `scripts/checklist.mjs`。
4. 脚本在当前项目生成 `report-checklist.md`；如果已有同名文件，脚本报错并保留原文件。
5. 遵循当前任务模式和审批要求。完成后给用户实际文件位置。
