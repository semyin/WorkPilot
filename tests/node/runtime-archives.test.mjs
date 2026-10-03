import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, access, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { root } from "../../scripts/cargo.mjs";

test(
  "runtime archives reject traversal, aliases, links and existing destinations",
  { skip: process.platform !== "win32" },
  async () => {
    const cache = join(root, ".local/p12-runtime-downloads");
    await mkdir(cache, { recursive: true });
    const folder = await mkdtemp(join(cache, "archive-test-"));
    const make = (file, entries) =>
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `
    $ErrorActionPreference='Stop'
    Add-Type -AssemblyName System.IO.Compression
    $stream=[IO.File]::Open($env:WORKPILOT_ARCHIVE_TEST_FILE,[IO.FileMode]::CreateNew)
    $zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
    try {
      foreach($name in ($env:WORKPILOT_ARCHIVE_TEST_ENTRIES|ConvertFrom-Json)) {
        $entry=$zip.CreateEntry($name)
        if($name -eq 'symlink') {$entry.ExternalAttributes=-1577058304}
        $writer=[IO.StreamWriter]::new($entry.Open());$writer.Write('fixture');$writer.Dispose()
      }
    } finally {$zip.Dispose();$stream.Dispose()}
  `,
        ],
        {
          windowsHide: true,
          env: {
            ...process.env,
            WORKPILOT_ARCHIVE_TEST_FILE: file,
            WORKPILOT_ARCHIVE_TEST_ENTRIES: JSON.stringify(entries),
          },
        },
      );
    const extract = (file, target) =>
      spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          join(root, "scripts/extract-runtime.ps1"),
          "-Archive",
          file,
          "-Destination",
          target,
        ],
        { windowsHide: true, encoding: "utf8" },
      );
    const bad = [["../escape.txt"], ["Case.txt", "case.txt"], ["symlink"]];
    for (const [i, entries] of bad.entries()) {
      const file = join(folder, `bad-${i}.zip`),
        target = join(folder, `bad-${i}`);
      make(file, entries);
      const result = extract(file, target);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      await assert.rejects(access(join(folder, "escape.txt")));
    }
    const file = join(folder, "valid.zip"),
      target = join(folder, "valid");
    make(file, ["nested/good.txt"]);
    const result = extract(file, target);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(await readFile(join(target, "nested/good.txt"), "utf8"), "fixture");
    await writeFile(join(target, "keep.txt"), "keep");
    assert.notEqual(extract(file, target).status, 0);
    assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "keep");
  },
);
