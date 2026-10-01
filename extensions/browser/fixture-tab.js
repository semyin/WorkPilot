export function requireFixtureTab(tab) {
  if (!tab || !Number.isInteger(tab.id)) {
    throw new Error("没有找到当前标签页。请先在 Chrome 或 Edge 中打开本地测试网页。");
  }
  if (typeof tab.url !== "string" || !tab.url.trim()) {
    throw new Error(
      "无法读取当前标签页地址。请切换到 http://127.0.0.1:端口/page 测试网页，再从该网页右上角打开 WorkPilot 扩展。不要在扩展管理页中点击验证；若已在测试页，请刷新扩展并确认它具有本地测试站点的访问权限。",
    );
  }
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    throw new Error(
      "当前标签页地址无法识别。请在浏览器地址栏完整输入本地测试页地址，再重新打开扩展。",
    );
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/page" ||
    tab.title !== "WorkPilot Browser Fixture"
  ) {
    throw new Error(
      "当前标签页不是 WorkPilot 测试网页。请先打开 http://127.0.0.1:端口/page，再点击扩展。",
    );
  }
  return url;
}
