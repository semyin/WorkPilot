import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export async function writeKitReport(output, report) {
  const passed = report.status === "passed";
  const title = passed ? "自动检查已通过" : "有检查未能通过";
  const failure = report.error || report.shutdownError || report.identityError;
  const rows = report.checks
    .map(
      (row) =>
        `<tr><td>${escape(row.name)}</td><td>${row.status === "passed" ? "通过" : "未通过"}</td><td>${Math.round(row.elapsedMs / 1000)} 秒</td></tr>`,
    )
    .join("");
  const pictures = (report.deliveries || [])
    .flatMap((item) => item.preview || item.screenshot || [])
    .map((file) => {
      const name = file.split(/[\\/]/).at(-1);
      return `<li><a href="${encodeURIComponent(name)}">${escape(name)}</a></li>`;
    })
    .join("");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WorkPilot 便携验收结果</title><style>
body{font:16px/1.7 system-ui,'Microsoft YaHei',sans-serif;margin:40px auto;padding:0 24px;max-width:1000px;color:#153149;background:#f5f8fb}article{background:white;border:1px solid #d9e3eb;padding:28px;border-radius:14px}h1{margin-top:0}table{border-collapse:collapse;width:100%}td,th{padding:10px;text-align:left;border-bottom:1px solid #d9e3eb}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef2f6;padding:16px}a{color:#075b9a}.result{color:${passed ? "#147144" : "#a33919"}}small{color:#526979}</style><article>
<h1>WorkPilot 便携验收结果</h1><h2 class="result">${title}</h2>
<p>${report.selfTest ? "这是开发机上的工具包自检，不代表干净系统或另一台电脑已经验收。" : "这是所选电脑上的自动检查结果。是否为干净系统、是否为另一台实体电脑，需要由操作者确认。"}</p>
<p>安装目录：${escape(report.installation)}<br>开始时间：${escape(report.startedAt)}<br>结束时间：${escape(report.endedAt)}</p>
<table><thead><tr><th>检查内容</th><th>结果</th><th>耗时</th></tr></thead><tbody>${rows}</tbody></table>
${failure ? `<h2>未通过的原因</h2><p>本次检查未完成，不能按通过记录。下面的原始信息便于开发者定位；此前已通过的项目仍保留。</p><pre>${escape(failure)}</pre>` : ""}
<h2>本次检查的范围</h2><p>检查软件自带组件、受限制的 Python/Node/Git 工具、本地已有资料、专用浏览器下载和 Word/Excel/PPT 生成预览。模型响应来自本机固定测试服务，不需要密钥，也不产生云模型费用。网络异常使用不可连接的本机地址，不等于拔网线或关闭系统网络。</p>
<h2>仍需人工确认</h2><ul><li>确认这台电脑的系统是否干净，以及是否为另一台实体电脑。</li><li>实际打开 WorkPilot，检查窗口、输入、任务、通知和安装/卸载体验。</li><li>如验收要求整机断网，需要操作者在真实断网后另外验证；工具包不会改动网络或电源设置。</li></ul>
<h2>查看测试产物</h2><ul>${pictures}</ul><p>所有产物和测试资料都在本次新建的结果目录。<a href="report.json">原始结果报告</a>包含程序校验值、运行环境和逐项数据；工具不会自动上传它们。</p>
<details><summary>程序校验值与退出情况</summary><pre>${escape(JSON.stringify({ identity: report.identity, finalIdentity: report.finalIdentity, engineExits: report.engineExits }, null, 2))}</pre></details>
<small>“自动检查通过”不等于整个 P13 或所有平台均已验收。请与项目验收清单一起使用。</small></article></html>`;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(output, "验收结果.html"), html);
}
