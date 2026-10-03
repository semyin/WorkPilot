const status = document.querySelector("#status");
const selected = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
document.querySelector("#tab").textContent = selected?.url || "请先打开要连接的 HTTP(S) 网页。";
const show = (r) => (status.textContent = JSON.stringify(r, null, 2));
show(await chrome.runtime.sendMessage({ kind: "status" }));
document.querySelector("#connect").onclick = async () => {
  try {
    show({ state: "connecting" });
    show(
      await chrome.runtime.sendMessage({
        kind: "connect",
        code: document.querySelector("#code").value.trim(),
        tab_id: selected.id,
      }),
    );
  } catch (e) {
    show({ error: String(e) });
  }
};
document.querySelector("#disconnect").onclick = async () =>
  show(await chrome.runtime.sendMessage({ kind: "disconnect" }));
