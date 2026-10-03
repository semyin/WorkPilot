import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BrowserSetupAction, BrowserSetupReport } from "./generated/contracts";
import { executionCommand } from "./executionClient";
import { useWords } from "./workspaceClient";
import "./installation.css";

export function BrowserSetupPanel() {
  const tr = useWords();
  const [report, setReport] = useState<BrowserSetupReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const guard = useRef(false);
  const mounted = useRef(true);

  async function act(action: BrowserSetupAction) {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await executionCommand({ kind: "browser_setup", action });
      if (response.kind !== "browser_setup")
        throw new Error(tr("连接检查未完成", "Setup check did not finish"));
      if (mounted.current) setReport(response.report);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      guard.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void act({ kind: "inspect" });
    return () => {
      mounted.current = false;
    };
  }, []);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(tr("已复制", "Copied"));
    } catch {
      setError(
        tr(
          "复制未成功，请选中文字后手动复制。",
          "Copy failed. Select the text and copy it manually.",
        ),
      );
    }
  }
  const states: Record<string, string> = {
    missing: tr("尚未配置本机连接", "Local connection is not configured"),
    ready: tr(
      "本机连接已配置，仍需浏览器授权",
      "Local connection configured; browser authorization still required",
    ),
    repair: tr("本机连接文件需要修复", "Local connection file needs repair"),
    conflict: tr(
      "连接由另一处安装或系统设置管理",
      "Connection belongs to another installation or system setting",
    ),
    unavailable: tr(
      "连接组件缺失或版本不匹配，请重新安装",
      "Companion files are missing or different; reinstall this copy",
    ),
    unsupported: tr(
      "此系统尚未提供连接安装功能",
      "Browser setup is not available on this platform yet",
    ),
  };
  return (
    <section
      className="browser-setup-panel"
      aria-label={tr("浏览器连接安装", "Browser connection setup")}
    >
      <p>
        {tr(
          "先为需要的浏览器配置本机连接，再在浏览器中加载扩展。完成这两步不会自动控制任何标签页。",
          "Configure the local connection, then load the extension in your browser. These steps do not authorize control of any tab.",
        )}
      </p>
      <button disabled={busy} onClick={() => void act({ kind: "inspect" })}>
        {tr("重新检查连接配置", "Refresh connection setup")}
      </button>
      {busy && <p role="status">{tr("正在检查或保存…", "Checking or saving…")}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {report?.browsers.map((b) => (
        <div className="browser-setup-card" key={b.browser} data-setup-browser={b.browser}>
          <h4>{b.browser === "chrome" ? "Chrome" : "Edge"}</h4>
          <p data-setup-state={b.state}>{states[b.state] || b.state}</p>
          {b.other_location && (
            <p className="browser-setup-path">
              {tr("现有连接位置：", "Existing connection: ")}
              {b.other_location}
            </p>
          )}
          {b.state === "conflict" && (
            <p>
              {tr(
                "请先从原安装位置解除本机连接配置，再回到这里重新检查。当前版本不会覆盖它。",
                "Remove the local connection using the original installation, then refresh here. This copy will not overwrite it.",
              )}
            </p>
          )}
          {b.fallback_detected && (
            <p>
              {tr(
                "Edge 可能沿用 Chrome 或 Chromium 的连接设置。这里的按钮只更改 Edge 自己的配置。",
                "Edge may fall back to Chrome or Chromium settings. These buttons only change Edge's own registration.",
              )}
            </p>
          )}
          <div className="model-actions">
            <button
              disabled={busy || !b.can_register}
              onClick={() => void act({ kind: "register", browser: b.browser })}
            >
              {b.state === "ready"
                ? tr("重新核对配置", "Recheck configuration")
                : tr("配置本机连接", "Configure local connection")}
            </button>
            <button
              disabled={busy || !b.can_unregister}
              onClick={() => void act({ kind: "unregister", browser: b.browser })}
            >
              {tr("移除本机配置", "Remove local configuration")}
            </button>
          </div>
        </div>
      ))}
      {report?.extension_directory && (
        <div>
          <h4>{tr("在浏览器中完成安装", "Finish installation in the browser")}</h4>
          <ol>
            <li>
              {tr(
                "打开所用浏览器的扩展管理页：Chrome 输入 chrome://extensions/，Edge 输入 edge://extensions/。",
                "Open chrome://extensions/ in Chrome or edge://extensions/ in Edge.",
              )}
            </li>
            <li>
              {tr(
                "打开“开发者模式”，选择“加载已解压的扩展”，再选择下方文件夹。",
                "Enable Developer mode, choose Load unpacked, then select the folder below.",
              )}
            </li>
            <li>
              {tr(
                "确认出现 WorkPilot Browser Companion。回到任务的浏览器面板生成连接码，在目标网页点击扩展并连接当前页。",
                "Check that WorkPilot Browser Companion appears. Get a code from the task's browser panel, then use the extension on your target page to connect it.",
              )}
            </li>
          </ol>
          <p className="browser-setup-path">{report.extension_directory}</p>
          <div className="model-actions">
            <button onClick={() => void copy(report.extension_directory!)}>
              {tr("复制扩展文件夹位置", "Copy extension folder")}
            </button>
            <button
              onClick={() =>
                void invoke("browser_extension_folder").catch(() =>
                  setError(
                    tr(
                      "无法打开扩展文件夹，请复制位置后手动打开。",
                      "Could not open the folder. Copy its location and open it manually.",
                    ),
                  ),
                )
              }
            >
              {tr("打开扩展文件夹", "Open extension folder")}
            </button>
          </div>
        </div>
      )}
      <small>
        {tr(
          "移除本机配置会阻止通过该配置建立新连接，不会移除浏览器扩展或立即停止已连接页面。请在扩展中断开当前页，或停止对应任务。卸载 WorkPilot 时只清理当前安装拥有的配置。",
          "Removing local configuration prevents new connections through that registration. It does not remove the extension or stop existing page connections. Disconnect in the extension or stop the task. Uninstall only removes registrations owned by this installation.",
        )}
      </small>
    </section>
  );
}
