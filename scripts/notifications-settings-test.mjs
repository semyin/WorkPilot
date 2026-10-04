import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { settingsHarness } from "./notifications-settings-harness.mjs";

const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || ".test-results/p13-notification-settings-race",
);
await mkdir(output, { recursive: true });
const report = {
  at: new Date().toISOString(),
  scope:
    "Actual NotificationSettings.tsx compiled with pure hooks and controlled delayed IPC; no native window, model or OS-setting changes",
  checks: [],
};
const cases = [
  [
    "late_old_success_and_error_cannot_revert_saved_preferences_or_the_next_toggle",
    async () => {
      const h = await settingsHarness();
      try {
        h.emit();
        const oldSuccess = h.takeRead();
        h.toggle(1, false);
        h.emit(); // The save event must not start an unsafe read during the mutation.
        await h.completeWrite(h.writes[0]);
        await h.settleRead();
        assert.equal(h.inputs()[1].props.checked, false);
        await h.settleRead(oldSuccess);
        assert.equal(h.inputs()[1].props.checked, false);
        h.emit();
        const oldFailure = h.takeRead();
        h.toggle(2, false);
        await h.completeWrite(h.writes[1]);
        await h.settleRead();
        oldFailure.reject(new Error("Delayed read failed"));
        await h.flush();
        assert.equal(h.backend.system, false);
        assert.equal(h.backend.tray, false);
        assert.equal(h.inputs()[1].props.checked, false);
        assert(!h.text().includes("暂时无法读取"));
        return {
          storedSystem: h.backend.system,
          storedTray: h.backend.tray,
          saves: h.writes.length,
        };
      } finally {
        h.unmount();
      }
    },
  ],
  [
    "successful_save_followed_by_failed_refresh_keeps_saved_value_and_reports_read_failure",
    async () => {
      const h = await settingsHarness();
      try {
        h.toggle(1, false);
        await h.completeWrite(h.writes[0]);
        h.takeRead().reject(new Error("Post-save read unavailable"));
        await h.flush();
        assert.equal(h.backend.system, false);
        assert.equal(h.inputs()[1].props.checked, false);
        assert(h.text().includes("通知设置已保存"));
        assert(h.text().includes("已保存的设置不受影响"));
        assert(!h.text().includes("未能保存，原设置保留"));
        h.toggle(2, false);
        assert.equal(h.writes[1].args.preferences.system, false);
        await h.completeWrite(h.writes[1]);
        await h.settleRead();
        assert(!h.text().includes("暂时无法读取"));
        return { savedValueRetained: true, nextSaveKeepsSystemOff: true };
      } finally {
        h.unmount();
      }
    },
  ],
  [
    "synchronous_reentry_is_blocked_and_test_delivery_survives_its_refresh_failure",
    async () => {
      const h = await settingsHarness();
      try {
        const inputs = h.inputs();
        inputs[1].props.onChange({ target: { checked: false } });
        inputs[2].props.onChange({ target: { checked: false } });
        assert.equal(h.writes.length, 1);
        assert(h.inputs().every((input) => input.props.disabled));
        await h.completeWrite(h.writes[0]);
        await h.settleRead();
        h.test();
        h.test();
        assert.equal(h.writes.length, 2);
        await h.completeWrite(h.writes[1], "submitted");
        h.takeRead().reject(new Error("Post-test read unavailable"));
        await h.flush();
        assert(h.text().includes("Delivery: submitted"));
        assert(h.text().includes("暂时无法读取"));
        assert(!h.text().includes("通知测试失败"));
        return { saveCalls: 1, testCalls: 1, deliveryResultRetained: true };
      } finally {
        h.unmount();
      }
    },
  ],
  [
    "unmount_invalidates_in_flight_read_and_save_without_late_ui_updates",
    async () => {
      const h = await settingsHarness();
      h.emit();
      const oldRead = h.takeRead();
      h.toggle(1, false);
      h.unmount();
      const updates = h.updates;
      await h.completeWrite(h.writes[0]);
      await h.settleRead(oldRead);
      assert.equal(h.updates, updates);
      assert.equal(h.reads.length, 0);
      assert.equal(h.backend.system, false);
      return { lateUiUpdates: h.updates - updates, postUnmountReads: h.reads.length };
    },
  ],
];
try {
  for (const [name, check] of cases)
    report.checks.push({ name, status: "passed", result: await check() });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
