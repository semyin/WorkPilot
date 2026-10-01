import { requireFixtureTab } from "./fixture-tab.js";

const output = document.querySelector("#result");
const target = document.querySelector("#target");
const probeButton = document.querySelector("#probe");
async function selectedTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  target.textContent = tab?.url || "当前标签页地址不可用（可能位于扩展管理页）";
  requireFixtureTab(tab);
  return tab;
}
probeButton.onclick = async () => {
  probeButton.disabled = true;
  output.textContent = "正在验证…";
  try {
    const tab = await selectedTab();
    const result = await chrome.runtime.sendMessage({ kind: "probe", tabId: tab.id });
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    output.textContent = JSON.stringify({ state: "error", error: error.message }, null, 2);
  } finally {
    probeButton.disabled = false;
  }
};
document.querySelector("#disconnect").onclick = async () => {
  try {
    output.textContent = JSON.stringify(
      await chrome.runtime.sendMessage({ kind: "disconnect" }),
      null,
      2,
    );
  } catch (error) {
    output.textContent = error.message;
  }
};
try {
  await selectedTab();
  output.textContent = JSON.stringify(
    await chrome.runtime.sendMessage({ kind: "status" }),
    null,
    2,
  );
} catch (error) {
  output.textContent = error.message;
}
