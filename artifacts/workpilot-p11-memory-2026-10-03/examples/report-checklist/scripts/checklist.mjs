import { writeFileSync } from "node:fs";
const content =
  "# 报告检查清单\n\n- [ ] 标题与日期\n- [ ] 数字的单位、口径和来源\n- [ ] 事实与推测\n- [ ] 负责人和下一步\n- [ ] 待补充信息\n";
writeFileSync("report-checklist.md", content, { encoding: "utf8", flag: "wx" });
console.log("已生成 report-checklist.md；未覆盖任何已有文件。");
