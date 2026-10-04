import fs from "node:fs";
import vm from "node:vm";
import * as jsx from "react/jsx-runtime";
import { transformSync } from "rolldown/experimental";

// A source-level controlled async reproduction, not a native UI test.
const source = "apps/desktop/src/notifications/NotificationSettings.tsx";
const js = transformSync(source, fs.readFileSync(source, "utf8"), {}).code;
let values = [], cursor = 0, mounted = false, effects = [], listener;
let backend = { in_app: true, system: true, tray: true, foreground: false };
const pending = [], saves = [];
const fresh = () => ({ preferences: structuredClone(backend), active: true,
  ready: true, system_available: false, storage_error: false });
const mocks = {
  react: {
    useContext: () => false,
    useRef: initial => {
      const index = cursor++;
      if (!(index in values)) values[index] = { current: initial };
      return values[index];
    },
    useState: initial => {
      const index = cursor++;
      if (!(index in values)) values[index] = initial;
      return [values[index], next => {
        values[index] = typeof next === "function" ? next(values[index]) : next;
      }];
    },
    useEffect: f => { if (!mounted) effects.push(f); },
    useCallback: f => f,
  },
  "react/jsx-runtime": jsx,
  "@tauri-apps/api/event": {
    listen: async (_, fn) => { listener = fn; return () => {}; },
  },
  "@tauri-apps/api/core": {
    invoke: async (name, args) => {
      if (name !== "notifications_save") throw new Error(name);
      backend = structuredClone(args.preferences);
      saves.push(structuredClone(backend));
    },
  },
  "../workspaceClient": { LanguageContext: {}, useWords: () => zh => zh },
  "./client": {
    notificationSnapshot: () => new Promise(resolve => pending.push({ snapshot: fresh(), resolve })),
    deliveryLabel: () => "",
  },
};
const context = vm.createContext({ console });
const component = new vm.SourceTextModule(js, { context });
await component.link(async id => {
  const mock = mocks[id];
  if (!mock) throw new Error(id);
  return new vm.SyntheticModule(Object.keys(mock), function () {
    for (const [key, value] of Object.entries(mock)) this.setExport(key, value);
  }, { context });
});
await component.evaluate();
const render = () => {
  cursor = 0;
  const result = component.namespace.NotificationSettings();
  if (!mounted) {
    mounted = true;
    for (const effect of effects) effect();
  }
  return result;
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const inputs = node => !node || typeof node !== "object" ? [] : Array.isArray(node)
  ? node.flatMap(inputs)
  : [...(node.type === "input" ? [node] : []), ...inputs(node.props?.children)];
const settle = request => request.resolve(request.snapshot);
render();
await flush();
settle(pending.shift());
await flush();
listener();
const delayed = pending.shift();
inputs(render())[1].props.onChange({ target: { checked: false } });
await flush();
settle(pending.shift());
await flush();
const afterSave = { storedSystem: backend.system, displayedSystem: inputs(render())[1].props.checked };
settle(delayed);
await flush();
const afterLateRead = { storedSystem: backend.system, displayedSystem: inputs(render())[1].props.checked };
inputs(render())[2].props.onChange({ target: { checked: false } });
await flush();
const afterTrayToggle = { storedSystem: backend.system, storedTray: backend.tray };
settle(pending.shift());
await flush();
console.log(JSON.stringify({
  test: "Actual NotificationSettings.tsx compiled with controlled pure hook/IPC mocks; no native app or provider calls",
  at: new Date().toISOString(),
  afterSave, afterLateRead, afterTrayToggle, saves,
  outcome: afterTrayToggle.storedSystem ? "reproduced" : "protected",
}, null, 2));
