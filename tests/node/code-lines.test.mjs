import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { countLines, inspectCodeLines } from "../../scripts/check-code-lines.mjs";

test("physical line counts handle empty files, final newline and Windows line endings", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("\n"), 1);
  assert.equal(countLines("一\r\n二\r\n"), 2);
  assert.equal(countLines("one\ntwo"), 2);
  assert.equal(countLines("one\rtwo\r"), 2);
});

test("line guard checks tracked and new code, including generated sources, with an exact 1000-line boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "workpilot-code-lines-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe" });
  try {
    git("init", "--quiet");
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await writeFile(join(root, "tracked.rs"), "// line\n".repeat(1000));
    await writeFile(join(root, "deleted.rs"), "// removed\n".repeat(1001));
    git("add", ".");
    await rm(join(root, "deleted.rs"));
    await mkdir(join(root, "new code"));
    await writeFile(join(root, "new code", "中文.tsx"), "// line\r\n".repeat(1001));
    await mkdir(join(root, "generated"));
    await writeFile(join(root, "generated", "contracts.ts"), "// line\n".repeat(1001));
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, "ignored", "output.js"), "x\n".repeat(1001));
    await mkdir(join(root, "artifacts"));
    await writeFile(join(root, "artifacts", "research.html"), "x\n".repeat(1001));
    await writeFile(join(root, "notes.md"), "x\n".repeat(1001));
    const report = await inspectCodeLines(root);
    assert.equal(report.files.length, 3);
    assert.equal(report.files.find(({ path }) => path === "tracked.rs").lines, 1000);
    assert.deepEqual(
      report.violations.map(({ path }) => path),
      ["generated/contracts.ts", "new code/中文.tsx"],
    );
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("workpilot-code-lines-"));
    await rm(root, { recursive: true, force: true });
  }
});
