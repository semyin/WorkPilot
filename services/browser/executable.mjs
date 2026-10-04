import { access, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

// The dedicated bundled channel never falls back to a personal browser installation.
export async function browserExecutable(channel, installationRoot, environment = process.env) {
  if (channel === "chromium") {
    if (!installationRoot) throw new Error("Bundled browser location is unavailable.");
    const root = await realpath(installationRoot);
    const executable = await realpath(
      join(root, "chromium-runtime", process.platform === "win32" ? "chrome.exe" : "chrome"),
    ).catch(() => {
      throw new Error(
        "随包浏览器缺失，请修复安装 / Bundled browser is missing; repair installation.",
      );
    });
    const rel = relative(root, executable);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Bundled browser leaves installation.");
    return executable;
  }
  if (!["chrome", "msedge"].includes(channel)) throw new Error("Unsupported browser.");
  const names =
    process.platform === "win32"
      ? [
          environment.PROGRAMFILES || "C:/Program Files",
          environment["PROGRAMFILES(X86)"] || "C:/Program Files (x86)",
          environment.LOCALAPPDATA || "",
        ].map((folder) =>
          join(
            folder,
            channel === "chrome"
              ? "Google/Chrome/Application/chrome.exe"
              : "Microsoft/Edge/Application/msedge.exe",
          ),
        )
      : process.platform === "darwin"
        ? [
            channel === "chrome"
              ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
              : "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : channel === "chrome"
          ? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
          : ["/usr/bin/microsoft-edge"];
  for (const path of names) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(
    "所选浏览器未安装，可使用随包浏览器 / This browser is not installed; use the bundled browser.",
  );
}
