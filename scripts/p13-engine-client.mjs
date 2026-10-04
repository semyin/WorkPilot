import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./cargo.mjs";

export async function eventually(check, timeout = 15000, interval = 10) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(interval);
  }
  throw new Error("P13 benchmark condition timed out");
}

export async function launchEngine(binary, directory, observe = () => {}) {
  const began = performance.now();
  const launchedAtMs = Date.now();
  const child = spawn(binary, ["--channel", "test", "--data-root", directory], {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let ready = false;
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes.toString()).slice(-8192);
  });
  const fail = (error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  const lines = createInterface({ input: child.stdout });
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
      } else if (value.event) {
        if (value.event.kind === "ready") ready = true;
        observe(value.event);
      }
    } catch (error) {
      fail(error);
    }
  });
  child.on("error", fail);
  child.on("exit", () => fail(new Error("Owned benchmark engine exited: " + stderr)));
  const request = (command) =>
    new Promise((resolve, reject) => {
      const request_id = crypto.randomUUID();
      const timer = setTimeout(
        () => {
          pending.delete(request_id);
          reject(new Error("P13 IPC timeout: " + command.kind + "; " + stderr));
        },
        command.kind === "media" && ["preview", "finish_upload"].includes(command.action?.kind)
          ? 120000
          : 15000,
      );
      pending.set(request_id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ request_id, command }) + "\n", (error) => {
        if (error) fail(error);
      });
    });
  try {
    await eventually(() => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Engine startup failed: " + stderr);
      return ready;
    });
  } catch (error) {
    child.kill(); // This launcher owns this child handle, never a process-name match.
    lines.close();
    throw error;
  }
  return {
    child,
    launchedAtMs,
    request,
    startupMs: performance.now() - began,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.stdin.end();
        let forced = false;
        const timeout = setTimeout(() => {
          forced = true;
          child.kill();
        }, 15000);
        try {
          await exit;
        } finally {
          clearTimeout(timeout);
        }
        if (forced || child.exitCode !== 0)
          throw new Error("Owned engine did not exit normally: " + stderr);
      }
      lines.close();
    },
  };
}

export async function snapshot(engine, task) {
  const result = await engine.request({
    kind: "read",
    query: { kind: "execution", task_id: task },
  });
  assert.equal(result.kind, "execution", JSON.stringify(result));
  return result.snapshot;
}
export async function team(engine, task) {
  const result = await engine.request({ kind: "read", query: { kind: "team", task_id: task } });
  assert.equal(result.kind, "team", JSON.stringify(result));
  return result.view;
}
export async function start(engine, task) {
  const result = await engine.request({ kind: "start_execution", task_id: task });
  assert.equal(result.kind, "receipt", JSON.stringify(result));
}
export async function finished(engine, task, state = "completed") {
  const result = await eventually(async () => {
    const value = await snapshot(engine, task);
    const terminal = ["completed", "failed", "interrupted", "awaiting_approval"].includes(
      value.task.state,
    );
    const unexpectedInput =
      value.task.state === "awaiting_input" && value.latest_run?.reason !== "team_waiting";
    return (terminal || unexpectedInput) && value;
  }, 30000);
  assert.equal(result.task.state, state, JSON.stringify(result.latest_run));
  return result;
}

export function eventObserver() {
  const running = new Map();
  const counts = {};
  let phase = null;
  return {
    running,
    counts,
    phase(value) {
      phase = value;
    },
    observe(event) {
      counts[event.kind] = (counts[event.kind] || 0) + 1;
      if (event.kind === "execution_started") running.set(event.run_id, event.task_id);
      if (event.kind === "execution_ended") running.delete(event.run_id);
      if (phase) {
        phase.peakRunning = Math.max(phase.peakRunning, running.size);
        const assistants = [...running.values()].filter((task) => !phase.roots.has(task)).length;
        phase.peakAssistants = Math.max(phase.peakAssistants, assistants);
      }
    },
  };
}
