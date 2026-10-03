import { useRef, useState } from "react";
import type { InstallationReport } from "./generated/contracts";
import { executionCommand } from "./executionClient";
import { useWords } from "./workspaceClient";
import "./installation.css";
export function InstallationPanel() {
  const tr = useWords(),
    busyRef = useRef(false);
  const [report, setReport] = useState<InstallationReport | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function inspect(verify_hashes: boolean) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await executionCommand({ kind: "inspect_installation", verify_hashes });
      if (r.kind !== "installation") throw new Error("Unexpected installation report");
      setReport(r.report);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }
  function download() {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2) + "\n"], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download =
      "WorkPilot-environment-" +
      new Date(report.checked_at_ms).toISOString().slice(0, 10) +
      ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const names: Record<string, string> = {
    application: tr("主程序与引擎", "Application and engine"),
    node: tr("JavaScript 运行环境", "JavaScript runtime"),
    python: tr("Python 运行环境", "Python runtime"),
    git: tr("代码版本工具", "Git tools"),
    chromium: tr("内置浏览器", "Bundled browser"),
    documents: tr("文档工具", "Document tools"),
    office: tr("Office 预览工具", "Office preview"),
    companion: tr("日常浏览器连接组件", "Daily browser companion"),
  };
  return (
    <section className="installation-panel" aria-label={tr("环境检查", "Environment check")}>
      <h3>{tr("环境检查与诊断", "Environment and diagnostics")}</h3>
      <p>
        {tr(
          "检查随包工具是否齐全。完整检查会核对文件内容，可能需要几十秒。",
          "Check the tools included with this installation. Full verification may take a few seconds.",
        )}
      </p>
      <div className="model-actions">
        <button disabled={busy} onClick={() => void inspect(false)}>
          {tr("检查环境", "Check environment")}
        </button>
        <button disabled={busy} onClick={() => void inspect(true)}>
          {tr("完整核验文件", "Verify all files")}
        </button>
        <button disabled={busy || !report} onClick={download}>
          {tr("导出环境诊断", "Export environment report")}
        </button>
      </div>
      {busy && (
        <p role="status">
          {tr("正在核对文件，你仍可继续其它任务…", "Checking files. Other tasks can keep running…")}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {report && (
        <>
          <p>
            {tr("程序版本：", "App version: ")}
            {report.app_version} · {report.platform} {report.architecture}
          </p>
          {report.components.map((c) => (
            <details key={c.id} data-runtime-id={c.id}>
              <summary>
                {names[c.id] || c.id} · {c.version} ·{" "}
                {c.state === "verified"
                  ? tr("内容已核对", "Verified")
                  : c.state === "present"
                    ? tr("文件齐全", "Files present")
                    : tr("需要修复", "Needs repair")}
              </summary>
              <p>
                {c.checked_files} / {c.files} {tr("个文件", "files")} ·{" "}
                {(c.bytes / 1048576).toFixed(1)} MiB
              </p>
              <p>
                {tr("来源：", "Source: ")}
                {c.source}
              </p>
              <p>
                {tr("许可：", "License: ")}
                {c.license}
              </p>
              {c.issues.length > 0 && (
                <ul>
                  {c.issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              )}
            </details>
          ))}
          {!report.manifest_present && (
            <p>
              {tr(
                "未找到分发清单，可能是开发版本，暂时不能判断环境是否齐全。",
                "No package inventory was found. This may be a development build; completeness is unknown.",
              )}
            </p>
          )}
          {report.notices.map((notice, index) => (
            <p key={index} className="installation-notice">
              {notice}
            </p>
          ))}
        </>
      )}
      <small>
        {tr(
          "报告只含程序版本、组件和文件检查结果，不包含项目内容、模型密钥或浏览器登录资料。只在你点击导出时保存文件，不自动上传。",
          "Reports contain versions, components and file checks, excluding projects, model keys and browser logins. Files are exported only on request and are never automatically uploaded.",
        )}
      </small>
    </section>
  );
}
