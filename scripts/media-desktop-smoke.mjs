import { chromium, expect as baseExpect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile, readFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { root } from "./cargo.mjs";
import { until, create, setFixture } from "./tool-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";
import { startImageFixture } from "../services/documents/image-fixture.mjs";
const expect = baseExpect.configure({ timeout: 30000 });
const output = process.env.WORKPILOT_TEST_OUTPUT || join(root, ".test-results/media-desktop");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-")),
  project = join(directory, "project");
await mkdir(project);
await copyFile(join(root, ".test-results/media-engine/sample.docx"), join(project, "报告.docx"));
await copyFile(join(root, ".test-results/media-engine/sample.pptx"), join(project, "演示.pptx"));
await copyFile(join(root, ".test-results/media-engine/sample.pdf"), join(project, "报告.pdf"));
const unsafe =
  '<script>window.__P10_UNSAFE=true;window.__TAURI_INTERNALS__.invoke("exit_app")</script><svg onload="window.__P10_UNSAFE=true"></svg>';
await writeFile(join(project, "untrusted.html"), unsafe);
const fixture = await startImageFixture(),
  model = await startToolFixture();
setFixture(model);
const binary =
  process.env.WORKPILOT_DESKTOP_BINARY || join(root, "target/release/workpilot-desktop.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binary: {
    path: binary,
    sha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
  },
  service: "Actual Windows WebView, document worker and files; synthetic Images API and model only",
  checks: [],
};
const ports = createServer().listen(0, "127.0.0.1");
await once(ports, "listening");
const port = ports.address().port;
await new Promise((r) => ports.close(r));
let child, browser, page;
const errors = [];
const request = (command) =>
  page.evaluate(
    (command) =>
      window.__TAURI_INTERNALS__.invoke("engine_command", {
        request: { request_id: crypto.randomUUID(), command },
      }),
    command,
  );
const assertReply = (r) => {
  assert(r.kind !== "error", r.message);
  return r;
};
function assert(value, message) {
  if (!value) throw new Error(message || "Desktop assertion failed");
}
try {
  child = spawn(binary, [], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WORKPILOT_CHANNEL: "test",
      WORKPILOT_DATA_DIR: directory,
      WEBVIEW2_USER_DATA_FOLDER: join(directory, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
    },
  });
  await until(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      return false;
    }
  }, 30000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(async () =>
    browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => /tauri\.localhost|tauri:/.test(p.url())),
  );
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(String(e)));
  await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible();
  const task = await create({ request }, "responses", "P10 文件与图片体验", {
    controlled_tools: false,
  });
  assertReply(
    await request({
      kind: "configure_task_tools",
      task_id: task,
      settings: {
        root_path: project,
        permission: "request_approval",
        commands_enabled: false,
        review_profile_id: null,
        revision: 0,
      },
    }),
  );
  await page.evaluate((task) => localStorage.setItem("workpilot.execution", task), task);
  await page.reload();
  await expect(page.getByLabel("发送新的要求", { exact: true })).toBeVisible();
  await page.getByLabel("添加文件或图片", { exact: true }).setInputFiles({
    name: "桌面附件.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("中文附件内容\n数值 42\n"),
  });
  await expect(
    page.locator(".attachment-chips").getByText("桌面附件.txt", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("发送新的要求", { exact: true }).fill("阅读刚刚添加的文件。");
  await page.getByRole("button", { name: "保存消息", exact: true }).click();
  await until(async () => {
    const r = assertReply(
      await request({ kind: "media", task_id: task, action: { kind: "list" } }),
    );
    return r.data.assets.some((a) => a.name === "桌面附件.txt");
  });
  report.checks.push("native_file_picker_upload_attaches_original_bytes_to_saved_message");
  // Synthetic DOM events exercise application handlers without reading/modifying the user's clipboard.
  await page.locator(".file-attachments").evaluate((el) => {
    const d = new DataTransfer();
    d.items.add(new File(["拖入的真实内容"], "拖入.txt", { type: "text/plain" }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: d }));
  });
  await expect(
    page.locator(".attachment-chips").getByText("拖入.txt", { exact: true }),
  ).toBeVisible();
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=";
  await page.getByLabel("发送新的要求", { exact: true }).evaluate((el, png) => {
    const d = new DataTransfer();
    d.items.add(
      new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "粘贴.png", {
        type: "image/png",
      }),
    );
    el.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: d }),
    );
  }, png);
  await expect(
    page.locator(".attachment-chips").getByText("粘贴.png", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("发送新的要求", { exact: true }).fill("保留这两个附件。");
  await page.getByRole("button", { name: "保存消息", exact: true }).click();
  report.checks.push(
    "drop_and_image_paste_event_handlers_import_files_without_accessing_system_clipboard",
  );
  await page.getByRole("button", { name: "文件成果与图片", exact: true }).click();
  let panel = page.getByRole("dialog", { name: "文件成果与图片", exact: true });
  await panel.getByLabel("读取项目文件", { exact: true }).fill("报告.docx");
  await panel.getByRole("button", { name: "读取文件", exact: true }).click();
  await expect(panel.locator(".media-detail")).toContainText("合计 42");
  await page.screenshot({ path: join(output, "documents-zh.png") });
  await panel.getByRole("button", { name: "查看原版式预览", exact: true }).click();
  await expect(panel.locator(".media-preview")).toBeVisible({ timeout: 110000 });
  await expect(panel.getByLabel("预览页码", { exact: true })).toHaveText("1 / 1");
  await expect(panel.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
  await page.screenshot({ path: join(output, "office-layout-zh.png") });
  report.checks.push(
    "native_docx_original_layout_preview_shows_real_page_count_and_keeps_original_file",
  );
  await panel.getByLabel("读取项目文件", { exact: true }).fill("演示.pptx");
  await panel.getByRole("button", { name: "读取文件", exact: true }).click();
  await expect(panel.locator(".media-detail h3")).toHaveText("演示.pptx");
  await panel.getByRole("button", { name: "查看原版式预览", exact: true }).click();
  await panel.getByRole("button", { name: "停止预览", exact: true }).click();
  await expect(panel.getByRole("button", { name: "查看原版式预览", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "查看原版式预览", exact: true }).click();
  await expect(panel.getByLabel("预览页码", { exact: true })).toHaveText("1 / 2", {
    timeout: 110000,
  });
  await panel.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(panel.getByLabel("预览页码", { exact: true })).toHaveText("2 / 2");
  await expect(panel.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
  await page.screenshot({ path: join(output, "office-slides-zh.png") });
  report.checks.push("native_slide_preview_can_stop_restart_and_page_to_actual_last_slide");
  await panel.getByLabel("读取项目文件", { exact: true }).fill("报告.pdf");
  await panel.getByRole("button", { name: "读取文件", exact: true }).click();
  await expect(panel.locator(".media-detail h3")).toHaveText("报告.pdf");
  await expect(panel.locator(".media-detail")).toContainText("Portable generated output 42");
  await expect(panel.locator(".media-detail")).toContainText(
    "Invoice A00123456789Z: 1234.56 -17 25/17 100%",
  );
  await expect(panel.locator(".media-detail")).not.toContainText(/[\uE000-\uF8FF]/u);
  await panel.getByRole("button", { name: "查看图像预览", exact: true }).click();
  await expect(panel.locator(".media-preview")).toBeVisible();
  await page.screenshot({ path: join(output, "pdf-preview-zh.png") });
  report.checks.push("native_office_content_and_actual_pdf_page_preview_use_saved_files");
  await panel.getByLabel("读取项目文件", { exact: true }).fill("untrusted.html");
  await panel.getByRole("button", { name: "读取文件", exact: true }).click();
  await expect(panel.locator(".media-detail")).toContainText("__P10_UNSAFE");
  assert((await page.evaluate(() => window.__P10_UNSAFE)) === undefined);
  await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible();
  await writeFile(join(project, "untrusted.html"), "外部修改后的内容 99");
  await panel.getByRole("button", { name: "读取最新版本", exact: true }).click();
  await expect(panel.locator(".media-detail")).toContainText("外部修改后的内容 99");
  report.checks.push(
    "untrusted_html_svg_are_text_only_no_host_script_execution_external_refresh_reads_new_snapshot",
  );
  await panel.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(
    panel.getByText("尚未配置图片服务。请先打开“图片服务设置”。", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "生成并保存到项目", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "图片服务设置", exact: true }).click();
  await panel.getByLabel("服务名称", { exact: true }).fill("本机图片协议测试");
  await panel.getByLabel("服务地址（到 /v1）", { exact: true }).fill(fixture.url);
  await panel.getByLabel("图片模型名称", { exact: true }).fill("fixture-image");
  await panel.getByText("服务支持的参数", { exact: true }).click();
  await panel.getByLabel("可选尺寸，用逗号分隔", { exact: true }).fill("32x16");
  await panel.getByLabel("需要密钥（只有本机服务可关闭）", { exact: true }).uncheck();
  await panel.getByRole("button", { name: "保存图片服务", exact: true }).click();
  await expect(
    panel.getByText("配置已保存。实际生成时会验证服务返回结果。", { exact: true }),
  ).toBeVisible();
  const services = assertReply(
    await request({ kind: "media", task_id: null, action: { kind: "image_services" } }),
  ).data.services;
  await panel.getByRole("button", { name: "生成图片", exact: true }).click();
  await panel.getByLabel("图片服务", { exact: true }).selectOption(services[0].id);
  await panel.getByLabel("图片要求或修改要求", { exact: true }).fill("normal");
  await panel.getByLabel("保存名称（项目内，不含扩展名）", { exact: true }).fill("ui-image");
  await panel.getByRole("button", { name: "生成并保存到项目", exact: true }).click();
  await expect(panel.getByRole("button", { name: "批准此生成请求", exact: true })).toBeVisible();
  assert(fixture.calls.length === 0, "Image service called before approval");
  await page.screenshot({ path: join(output, "image-approval-zh.png") });
  await panel.getByRole("button", { name: "批准此生成请求", exact: true }).click();
  await until(
    async () => (await panel.locator('[data-operation-state="completed"]').count()) > 0,
    100000,
  );
  assert(fixture.calls.length === 1);
  await panel.getByRole("button", { name: "附件与成果", exact: true }).click();
  await panel.getByRole("button", { name: "ui-image.png", exact: true }).click();
  await panel.getByRole("button", { name: "查看图像预览", exact: true }).click();
  await expect(panel.locator(".media-preview")).toBeVisible();
  await panel.getByRole("button", { name: "继续修改这张图", exact: true }).click();
  await expect(panel.getByLabel("ui-image.png", { exact: true })).toBeChecked();
  report.checks.push(
    "unconfigured_image_service_is_explicit_native_settings_generate_approval_save_preview_and_edit_reference",
  );
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Files and images", exact: true }).click();
  panel = page.getByRole("dialog", { name: "Files and images", exact: true });
  await expect(panel.getByRole("button", { name: "Generate images", exact: true })).toBeVisible();
  await page.screenshot({ path: join(output, "files-images-en.png") });
  const fit = await panel.evaluate((el) => ({ width: el.scrollWidth, view: el.clientWidth }));
  assert(fit.width <= fit.view + 2, "Panel overflows horizontally");
  assert(errors.length === 0, errors.join("\n"));
  report.checks.push("english_ui_no_horizontal_overflow_or_javascript_errors");
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  report.stack = e.stack;
  process.exitCode = 1;
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    if (page)
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
    else child.kill();
    await exited;
  }
  await browser?.close().catch(() => {});
  await fixture.close();
  await model.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
