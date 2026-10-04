import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { generateDocument } from "../../services/documents/write.mjs";
import { parse } from "../../services/documents/worker.mjs";

const output = resolve(process.env.WORKPILOT_PDF_TEST_OUTPUT || ".test-results/pdf-text");
const runtime = resolve("services/documents");
async function generate(name, recipe) {
  await mkdir(output, { recursive: true });
  const bytes = Buffer.from(await generateDocument("pdf", recipe, runtime));
  await writeFile(join(output, name), bytes);
  const report = await parse(bytes, name);
  await writeFile(join(output, name + ".json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

test("PDF preserves digits in English/Chinese titles, paragraphs and table cells", async () => {
  const title = "PDF 文字核对 42";
  const heading = "Results 25 / 17";
  const paragraphs = [
    "Portable generated output 42",
    "Invoice A00123456789Z: 1234.56 -17 25/17 100%",
    "中文金额 42，合计￥1234.56。",
    "English office efficient affine fi ffi",
    "Digits 0123456789 and 9876543210",
  ];
  const report = await generate("mixed-text.pdf", {
    title,
    sections: [
      {
        heading,
        paragraphs,
        table: {
          columns: ["Item", "Amount"],
          rows: [
            ["Income-25", 25],
            ["Other-17", 17],
            ["Total-42", 42],
          ],
        },
      },
    ],
  });
  const content = report.units.map((u) => u.text).join("\n");
  for (const expected of [title, heading, ...paragraphs, "Income-25", "Other-17", "Total-42"])
    assert(content.includes(expected), `Missing original text: ${expected}\n${content}`);
  assert(!/[\uE000-\uF8FF]/u.test(content), "Ordinary digits became private-use characters");
  assert.equal(report.units.length, 1);
});

test("PDF keeps numeric identifiers across wrapping, page breaks and page numbers", async () => {
  const rows = Array.from(
    { length: 90 },
    (_, i) => `Row-${String(i).padStart(3, "0")} 中文金额 000123.45, balance 42.`,
  );
  const long = "Long numeric reference " + "0123456789-".repeat(15);
  const report = await generate("multi-page.pdf", {
    title: "Paged PDF 42",
    sections: [{ heading: "Numeric rows 90", paragraphs: [long, ...rows] }],
  });
  assert(report.units.length >= 3, "Fixture must cross page boundaries");
  const content = report.units.map((u) => u.text).join("\n");
  for (const row of rows) assert(content.includes(row), `Missing original row: ${row}`);
  assert(report.units[0].text.replace(/\s+/g, "").includes(long.replace(/\s+/g, "")));
  report.units.forEach((u, i) => {
    assert(u.text.includes(`${i + 1} / ${report.units.length}`), "Incorrect page footer");
    assert(!/[\uE000-\uF8FF]/u.test(u.text), "Unexpected private-use character");
  });
});

test("PDF still rejects a character missing from the bundled font", async () => {
  await assert.rejects(
    generateDocument("pdf", { title: "Unsupported \u{10FFFF}" }, runtime),
    /PDF font does not support U\+10FFFF/,
  );
});
