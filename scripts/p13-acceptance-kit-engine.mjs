import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

// Portable equivalent of the existing JSONL test transport, using only Node built-ins.
export async function launchKitEngine(binary, directory) {
  const child = spawn(binary, ["--channel", "test", "--data-root", directory], {
    cwd: directory,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let ready = false,
    startupError,
    stderr = "";
  const fail = (error) => {
    startupError = error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  const lines = createInterface({ input: child.stdout });
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes.toString()).slice(-4096);
  });
  child.on("error", fail);
  child.on("exit", () => fail(new Error("测试引擎已经退出：" + stderr)));
  lines.on("line", (line) => {
    try {
      const value = JSON.parse(line);
      if (value.type === "reply") {
        const item = pending.get(value.request_id);
        if (item) {
          clearTimeout(item.timer);
          pending.delete(value.request_id);
          item.resolve(value.response);
        }
      } else if (value.event?.kind === "ready") ready = true;
    } catch (error) {
      fail(error);
    }
  });
  const began = performance.now();
  try {
    while (!ready) {
      if (startupError) throw startupError;
      if (performance.now() - began > 20000) throw new Error("测试引擎未能在 20 秒内启动");
      await delay(20);
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    lines.close();
    throw error;
  }
  return {
    child,
    startupMs: performance.now() - began,
    request(command) {
      return new Promise((resolve, reject) => {
        const request_id = crypto.randomUUID();
        const long =
          command.kind === "inspect_installation" ||
          (command.kind === "media" && ["preview", "finish_upload"].includes(command.action?.kind));
        const timer = setTimeout(
          () => {
            pending.delete(request_id);
            reject(new Error("测试请求超时：" + command.kind));
          },
          long ? 120000 : 15000,
        );
        pending.set(request_id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ request_id, command }) + "\n", (error) => {
          if (error) fail(error);
        });
      });
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        let forced = false;
        const timer = setTimeout(() => {
          forced = true;
          child.kill();
        }, 15000);
        child.stdin.end();
        try {
          await exited;
        } finally {
          clearTimeout(timer);
          lines.close();
        }
        if (forced || child.exitCode !== 0) throw new Error("测试引擎未能正常退出：" + stderr);
      } else lines.close();
      return { pid: child.pid, exitCode: child.exitCode, normal: child.exitCode === 0 };
    },
  };
}
