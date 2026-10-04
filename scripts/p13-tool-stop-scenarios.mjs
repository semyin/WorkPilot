import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eventually } from "./p13-engine-client.mjs";
import { aggregate, identity } from "./p13-desktop-resource-support.mjs";
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );
const normalized = (path) =>
  path
    .replace(/^\\\\\?\\/, "")
    .replaceAll("/", "\\")
    .toLowerCase();
export function officeRecipe(format, index, marker) {
  if (format === "docx")
    return {
      title: marker,
      sections: Array.from({ length: 60 }, (_, i) => ({
        heading: `Block ${i}`,
        paragraphs: [`${marker} repeated content 42. `.repeat(80)],
      })),
    };
  if (format === "xlsx")
    return {
      title: marker,
      sheets: [
        {
          name: "Data",
          rows: Array.from({ length: 180 }, (_, i) =>
            Array.from({ length: 8 }, (_, j) => `${marker} row ${i} col ${j}`),
          ),
        },
      ],
    };
  return {
    title: marker,
    slides: Array.from({ length: 50 }, (_, i) => ({
      title: `${marker} slide ${i}`,
      body: Array.from({ length: 8 }, () => marker),
    })),
  };
}
async function officeLedgers(context, program) {
  const folder = join(context.directory, "test/tool-sandboxes");
  const entries = [];
  for (const name of await readdir(folder).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const path = join(folder, name);
    const value = await readFile(path, "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (value?.paths?.some((path) => normalized(path) === normalized(program)))
      entries.push({ path, workspace: value.paths[0], name: value.name });
  }
  return entries;
}
export function stopScenarios(context, report) {
  return {
    officeRecipe,
    async closeBrowser({ workbench, session }) {
      await context.telemetry.refresh();
      let rows = context.telemetry.current.filter((row) => row.role === "dedicated-browser");
      assert(rows.some((row) => row.pid === session.owned_pid));
      const snapshot = context.telemetry.current;
      const beganAtMs = Date.now();
      let resources, resourceGroup;
      do {
        await delay(1000);
        context.telemetry.check();
        resources = aggregate(
          context.telemetry.collector.samples.filter((row) => row.atMs >= beganAtMs),
          context.telemetry.currentPhase,
          report.machine.logicalProcessors,
          [{ identities: snapshot.map(identity) }],
        );
        resourceGroup = resources.groups.find((row) => row.role === "dedicated-browser");
      } while ((resourceGroup?.samples || 0) < 20 && Date.now() - beganAtMs < 15000);
      assert(
        resourceGroup?.samples >= 20,
        "Dedicated-browser resource observation requires 20 complete cycles",
      );
      const observationEndedAtMs = Date.now();
      await context.telemetry.refresh();
      rows = context.telemetry.current.filter((row) => row.role === "dedicated-browser");
      assert(rows.some((row) => row.pid === session.owned_pid));
      assert(alive(session.owned_pid), "The dedicated browser must be alive at the stop request");
      const began = performance.now();
      let acknowledgementMs;
      const closing = workbench
        .wb({ kind: "browser_control", control: { kind: "disconnect", session_id: session.id } })
        .then((value) => {
          acknowledgementMs = performance.now() - began;
          return value;
        });
      closing.catch(() => {});
      await eventually(() => rows.every((row) => !alive(row.pid)), 10000, 5);
      const processExitMs = performance.now() - began;
      await closing;
      const verification = await context.telemetry.collector.verify(rows);
      assert(verification.every((row) => ["exited", "pid_reused"].includes(row.status)));
      const result = {
        acknowledgementMs,
        processExitMs,
        identities: rows,
        verification,
        resources,
        observationBeganAtMs: beganAtMs,
        observationEndedAtMs,
      };
      report.browser.push(result);
      return result;
    },
    async previewOffice({ workbench, asset, format, index }) {
      let settled = false;
      const requestedAtMs = Date.now();
      const pending = context.engine
        .request({
          kind: "media",
          task_id: workbench.task,
          action: { kind: "preview", asset_id: asset.id, page: 1 },
        })
        .finally(() => {
          settled = true;
        });
      const observed = context.telemetry.monitor(pending, 0);
      observed.catch(() => {});
      let office;
      try {
        office = await eventually(
          () => {
            const row = context.telemetry.current.find(
              (row) =>
                row.role === "office-converter" &&
                row.startedAtMs >= requestedAtMs &&
                alive(row.pid),
            );
            if (row) return row;
            if (settled)
              throw new Error(
                "Office preview ended before a live converter was observed; this is not a stop sample",
              );
            return false;
          },
          100000,
          10,
        );
      } catch (error) {
        await observed;
        throw error;
      }
      const ledgers = await officeLedgers(context, office.path);
      assert(ledgers.length, "The live Office sandbox must have its own cleanup journal");
      assert(alive(office.pid), "Office converter must still be alive when cancellation begins");
      const began = performance.now();
      let acknowledgementMs, replyMs, cleanupMs, workspaceCleanupMs, cancellationReply;
      const acknowledgement = workbench
        .media({ kind: "cancel_preview", asset_id: asset.id })
        .then(() => {
          acknowledgementMs = performance.now() - began;
        });
      const completed = pending.then((value) => {
        replyMs = performance.now() - began;
        assert.equal(value.kind, "error", JSON.stringify(value));
        assert.match(JSON.stringify(value), /cancelled|stopped|取消|停止/i);
        cancellationReply = value;
      });
      const cleanup = eventually(
        async () => {
          if ((await Promise.all(ledgers.map((row) => exists(row.path)))).some(Boolean))
            return false;
          cleanupMs = performance.now() - began;
          return true;
        },
        120000,
        10,
      );
      const workspace = eventually(
        async () => {
          if ((await Promise.all(ledgers.map((row) => exists(row.workspace)))).some(Boolean))
            return false;
          workspaceCleanupMs = performance.now() - began;
          return true;
        },
        120000,
        10,
      );
      for (const operation of [acknowledgement, completed, cleanup, workspace])
        operation.catch(() => {});
      await eventually(() => !alive(office.pid), 10000, 5);
      const processExitMs = performance.now() - began;
      await Promise.all([acknowledgement, completed, cleanup, workspace, observed]);
      const verification = await context.telemetry.collector.verify([office]);
      assert(verification.every((row) => ["exited", "pid_reused"].includes(row.status)));
      report.office.push({
        index,
        format,
        identity: office,
        acknowledgementMs,
        processExitMs,
        cleanupMs,
        workspaceCleanupMs,
        replyMs,
        verification,
        ledgers,
        cancellationReply,
      });
      // Complete a fresh real conversion after cancellation; verify its product output.
      return context.telemetry.monitor(
        workbench.media({ kind: "preview", asset_id: asset.id, page: 1 }),
        0,
      );
    },
  };
}
