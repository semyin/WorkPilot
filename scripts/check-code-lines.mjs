import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_CODE_LINES = 1000;
const extensions = new Set([
  ".rs",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".vue",
  ".svelte",
  ".sql",
  ".py",
  ".ps1",
  ".psm1",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".bat",
  ".cmd",
  ".nsh",
  ".nsi",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".go",
  ".swift",
  ".kt",
  ".java",
  ".rb",
  ".php",
  ".lua",
  ".r",
]);

export function countLines(text) {
  if (!text) return 0;
  const lines = text.split(/\r\n|\n|\r/);
  return lines.length - (lines.at(-1) === "" ? 1 : 0);
}

export function isCodeFile(path) {
  // Historical deliverables/research and evidence are immutable, not product sources.
  return !path.startsWith("artifacts/") && extensions.has(extname(path).toLowerCase());
}

export async function inspectCodeLines(root) {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", windowsHide: true },
  )
    .split("\0")
    .filter(Boolean);
  const files = [];
  for (const path of [...new Set(paths)].filter(isCodeFile).sort()) {
    let text;
    try {
      text = await readFile(resolve(root, path), "utf8");
    } catch (error) {
      // A tracked file removed during a refactor is no longer part of the working tree.
      if (error.code === "ENOENT") continue;
      throw error;
    }
    files.push({ path, lines: countLines(text) });
  }
  return {
    limit: MAX_CODE_LINES,
    files,
    violations: files.filter(({ lines }) => lines > MAX_CODE_LINES),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  try {
    const report = await inspectCodeLines(root);
    for (const file of report.violations) {
      console.error(
        `${file.path}: ${file.lines} lines (limit ${report.limit}); split by responsibility.`,
      );
    }
    if (report.violations.length) {
      console.error(`${report.violations.length} code file(s) exceed the limit.`);
      process.exitCode = 1;
    } else {
      const maximum = Math.max(0, ...report.files.map(({ lines }) => lines));
      console.log(
        `Code line check passed: ${report.files.length} files, maximum ${maximum}/${report.limit} lines.`,
      );
    }
  } catch (error) {
    console.error(`Code line check could not complete: ${error.message}`);
    process.exitCode = 1;
  }
}
