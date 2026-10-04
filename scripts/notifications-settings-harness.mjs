import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as jsx from "react/jsx-runtime";
import { transformSync } from "rolldown/experimental";

// Compile the real component; only hooks and delayed desktop IPC are replaced.
// This controls response ordering without opening an app or changing OS settings.
export async function settingsHarness() {
  const source = "apps/desktop/src/notifications/NotificationSettings.tsx";
  const compiled = transformSync(source, await readFile(source, "utf8"), {}).code;
  const values = [],
    effects = [],
    cleanups = [],
    reads = [],
    writes = [];
  let cursor = 0,
    mounted = false,
    listener,
    updates = 0;
  let backend = { in_app: true, system: true, tray: true, foreground: false };
  const fresh = () => ({
    preferences: structuredClone(backend),
    active: true,
    ready: true,
    system_available: false,
    storage_error: false,
  });
  const mocks = {
    react: {
      useContext: () => false,
      useRef: (initial) => {
        const index = cursor++;
        if (!(index in values)) values[index] = { current: initial };
        return values[index];
      },
      useState: (initial) => {
        const index = cursor++;
        if (!(index in values)) values[index] = initial;
        return [
          values[index],
          (next) => {
            updates++;
            values[index] = typeof next === "function" ? next(values[index]) : next;
          },
        ];
      },
      useEffect: (effect) => {
        if (!mounted) effects.push(effect);
      },
    },
    "react/jsx-runtime": jsx,
    "@tauri-apps/api/event": {
      listen: async (_, callback) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    },
    "@tauri-apps/api/core": {
      invoke: (name, args) =>
        new Promise((resolve, reject) => {
          assert(["notifications_save", "notifications_test"].includes(name));
          writes.push({ name, args, resolve, reject });
        }),
    },
    "../workspaceClient": { LanguageContext: {}, useWords: () => (zh) => zh },
    "./client": {
      notificationSnapshot: () =>
        new Promise((resolve, reject) => reads.push({ snapshot: fresh(), resolve, reject })),
      deliveryLabel: (result) => "Delivery: " + result,
    },
  };
  const context = vm.createContext({ console });
  const component = new vm.SourceTextModule(compiled, { context });
  await component.link(async (id) => {
    const mock = mocks[id];
    assert(mock, "Unexpected component import: " + id);
    return new vm.SyntheticModule(
      Object.keys(mock),
      function () {
        for (const [key, value] of Object.entries(mock)) this.setExport(key, value);
      },
      { context },
    );
  });
  await component.evaluate();
  const render = () => {
    cursor = 0;
    const tree = component.namespace.NotificationSettings();
    if (!mounted) {
      mounted = true;
      cleanups.push(...effects.map((effect) => effect()));
    }
    return tree;
  };
  const nodes = (node) =>
    !node || typeof node !== "object"
      ? []
      : Array.isArray(node)
        ? node.flatMap(nodes)
        : [node, ...nodes(node.props?.children)];
  const content = (node) =>
    typeof node === "string"
      ? node
      : Array.isArray(node)
        ? node.map(content).join("")
        : node && typeof node === "object"
          ? content(node.props?.children)
          : "";
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const takeRead = () => {
    assert(reads.length, "Expected a new snapshot request");
    return reads.shift();
  };
  const settleRead = async (read = takeRead()) => {
    read.resolve(read.snapshot);
    await flush();
  };
  const completeWrite = async (write, result = "submitted") => {
    assert(write);
    if (write.name === "notifications_save") backend = structuredClone(write.args.preferences);
    write.resolve(result);
    await flush();
  };
  render();
  await flush();
  await settleRead();
  return {
    reads,
    writes,
    flush,
    render,
    takeRead,
    settleRead,
    completeWrite,
    emit: () => {
      assert(listener);
      listener();
    },
    inputs: () => nodes(render()).filter((node) => node.type === "input"),
    test: () =>
      nodes(render())
        .find((node) => node.type === "button" && content(node) === "发送一条测试通知")
        .props.onClick(),
    toggle(index, value) {
      this.inputs()[index].props.onChange({ target: { checked: value } });
    },
    text: () => content(render()),
    get backend() {
      return backend;
    },
    get updates() {
      return updates;
    },
    unmount() {
      cleanups.forEach((cleanup) => cleanup?.());
    },
  };
}
