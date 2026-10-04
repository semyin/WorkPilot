import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function until(check, timeout = 20000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  throw new Error("P13 native benchmark did not reach its expected state");
}

export const request = (page, command) =>
  page.evaluate(
    (command) =>
      window.__TAURI_INTERNALS__.invoke("engine_command", {
        request: { request_id: crypto.randomUUID(), command },
      }),
    command,
  );

export async function launchDesktop(binary, directory) {
  await mkdir(directory, { recursive: true });
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const started = performance.now();
  const child = spawn(binary, [], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WORKPILOT_CHANNEL: "test",
      WORKPILOT_DATA_DIR: directory,
      WEBVIEW2_USER_DATA_FOLDER: join(directory, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        "--remote-debugging-address=127.0.0.1 --remote-debugging-port=" + port,
    },
  });
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  let browser;
  try {
    await until(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("The benchmark desktop exited before becoming ready");
      return fetch(`http://127.0.0.1:${port}/json/version`).then(
        (r) => r.ok,
        () => false,
      );
    });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await until(async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => /tauri\.localhost|tauri:/.test(p.url())),
    );
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await expect(page.getByText(/^(引擎已连接|Engine connected)$/)).toBeVisible();
    await expect(page.getByLabel(/^(你想完成什么？|What would you like to do\?)$/)).toBeEnabled();
    return { child, browser, page, errors, startupObservedMs: performance.now() - started };
  } catch (e) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await browser?.close().catch(() => {});
    throw e;
  }
}

export async function quitDesktop(session) {
  if (!session) return;
  const { child, browser, page } = session;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    let timeout;
    try {
      await Promise.race([
        (async () => {
          await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
          await exited;
        })(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill();
            reject(new Error("Own desktop did not exit through its normal exit action"));
          }, 6000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      await browser.close().catch(() => {});
    }
    return;
  }
  await browser.close().catch(() => {});
}

export function distribution(values, targetMs, scope) {
  if (values.length < 20 || values.some((n) => !Number.isFinite(n) || n < 0))
    throw new Error("At least 20 valid timing samples are required: " + scope);
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => Math.round(sorted[Math.ceil(sorted.length * p) - 1] * 100) / 100;
  return {
    scope,
    samples: values.map((n) => Math.round(n * 100) / 100),
    count: values.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maximumMs: sorted.at(-1),
    targetMs,
    withinTarget: targetMs === null ? null : percentile(0.95) <= targetMs,
  };
}
