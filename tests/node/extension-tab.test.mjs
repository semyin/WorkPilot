import test from "node:test";
import assert from "node:assert/strict";
import { requireFixtureTab } from "../../extensions/browser/fixture-tab.js";

test("missing URL is explained without constructing an invalid URL or broadening access", () => {
  for (const url of [undefined, null, "", "   "]) {
    assert.throws(() => requireFixtureTab({ id: 1, url }), /无法读取当前标签页地址/);
  }
  assert.throws(() => requireFixtureTab(undefined), /没有找到当前标签页/);
  assert.throws(() => requireFixtureTab({ id: 1, url: "not-a-url" }), /地址无法识别/);
});
test("only the local fixture is accepted", () => {
  const tab = { id: 1, title: "WorkPilot Browser Fixture", url: "http://127.0.0.1:63695/page" };
  assert.equal(requireFixtureTab(tab).pathname, "/page");
  for (const url of [
    "chrome://extensions",
    "https://example.com/page",
    "http://127.0.0.1:63695/health",
    "http://127.0.0.1.evil.test/page",
  ]) {
    assert.throws(() => requireFixtureTab({ ...tab, url }), /不是 WorkPilot 测试网页/);
  }
  assert.throws(
    () => requireFixtureTab({ ...tab, title: "Some other app" }),
    /不是 WorkPilot 测试网页/,
  );
});
test("an inaccessible tab never reaches native messaging or debugger attach", async () => {
  const previousChrome = globalThis.chrome;
  let listener;
  let nativeCalls = 0;
  globalThis.chrome = {
    tabs: { get: async () => ({ id: 1 }) },
    runtime: {
      id: "test-extension",
      getURL: (file) => "chrome-extension://test-extension/" + file,
      onMessage: {
        addListener: (handler) => {
          listener = handler;
        },
      },
      connectNative: () => {
        nativeCalls++;
        throw new Error("must not be called");
      },
    },
  };
  try {
    await import("../../extensions/browser/background.js");
    const result = await new Promise((resolve) =>
      listener(
        { kind: "probe", tabId: 1 },
        { id: "test-extension", url: "chrome-extension://test-extension/popup.html" },
        resolve,
      ),
    );
    assert.equal(result.state, "error");
    assert.match(result.error, /无法读取当前标签页地址/);
    assert.equal(nativeCalls, 0);
  } finally {
    globalThis.chrome = previousChrome;
  }
});
