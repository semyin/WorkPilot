import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { parse, execute } from "../services/documents/worker.mjs";
const run = promisify(execFile),
  root = process.cwd(),
  folder = resolve(".test-results/media-office-open");
await mkdir(folder, { recursive: true });
const office = resolve(".local/p10-office-check/extracted/program/soffice.com"),
  profile = pathToFileURL(resolve(".test-results/p10-office-profile")).href;
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  method:
    "Actual LibreOffice 26.8.0 headless opens generated OOXML; PDF.js rasterizes the actual saved PDF",
  files: [],
  checks: [],
};
try {
  for (const format of ["docx", "xlsx", "pptx"]) {
    const input = resolve(`.test-results/media-engine/sample.${format}`),
      output = join(folder, format);
    await mkdir(output, { recursive: true });
    const result = await run(
      office,
      [
        `-env:UserInstallation=${profile}`,
        "--headless",
        "--nologo",
        "--norestore",
        "--convert-to",
        "pdf",
        "--outdir",
        output,
        input,
      ],
      { windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 },
    );
    const pdf = await readFile(join(output, "sample.pdf"));
    const parsed = await parse(pdf, "sample.pdf");
    assert(
      parsed.units.some((u) => u.text.includes("42")),
      `${format}: key value not found`,
    );
    for (let page = 1; page <= parsed.units.length; page++) {
      const temp = await mkdtemp(join(folder, "render-"));
      await writeFile(join(temp, "input.bin"), pdf);
      process.chdir(temp);
      await execute({ kind: "preview", name: "sample.pdf", page });
      process.chdir(root);
      await copyFile(join(temp, "preview.png"), join(output, `page-${page}.png`));
    }
    report.files.push({
      format,
      opened: true,
      pages: parsed.units.length,
      sourceSha256: createHash("sha256")
        .update(await readFile(input))
        .digest("hex"),
      pdfSha256: createHash("sha256").update(pdf).digest("hex"),
      actualText: parsed.units.map((u) => u.text),
      converterOutput: result.stdout.trim(),
    });
  }
  report.checks.push(
    "docx_xlsx_pptx_opened_by_independent_office_engine_actual_pdf_pages_rendered_and_value_42_preserved",
  );
  const protectedOutput = join(folder, "encrypted");
  await mkdir(protectedOutput, { recursive: true });
  await run(
    office,
    [
      `-env:UserInstallation=${profile}`,
      "--headless",
      "--nologo",
      "--norestore",
      "--convert-to",
      'pdf:writer_pdf_Export:{"EncryptFile":{"type":"boolean","value":"true"},"DocumentOpenPassword":{"type":"string","value":"fixture-only-password"}}',
      "--outdir",
      protectedOutput,
      resolve(".test-results/media-engine/sample.docx"),
    ],
    { windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 },
  );
  const encrypted = await readFile(join(protectedOutput, "sample.pdf"));
  let protectedError;
  try {
    await parse(encrypted, "protected.pdf");
  } catch (e) {
    protectedError = e;
  }
  assert.equal(protectedError?.name, "PasswordException");
  report.checks.push("actual_password_protected_pdf_is_rejected_as_encrypted");
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e.stack || e);
  throw e;
} finally {
  process.chdir(root);
  await writeFile(join(folder, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
