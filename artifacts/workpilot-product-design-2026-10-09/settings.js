const settingsSections = [
  ["general", "通用与外观", "settings"],
  ["models", "模型服务", "spark"],
  ["permissions", "任务与权限", "shield"],
  ["connections", "浏览器与连接", "globe"],
  ["notifications", "通知", "bell"],
  ["memory", "记忆", "files"],
  ["data", "数据与维护", "folder"],
];
let savedSettings = {
  theme: "light",
  model: "Qwen",
  permission: "请求审批",
  motion: true,
  inApp: true,
  system: true,
  tray: true,
};
let settingsDraft = null;
let settingsSection = "general";
const choice = (value, label = value, description) => ({
  value,
  label,
  description,
});
function settingsChoice(id, label, key, options) {
  return dropdown(id, label, settingsDraft[key], options, (value) => {
    settingsDraft[key] = value;
    renderSettings(false);
  });
}
function settingsRow(title, description, control) {
  return `<div class="settings-row"><div><strong>${title}</strong><p>${description}</p></div>${control}</div>`;
}
function settingSwitch(key, title, description) {
  return settingsRow(
    title,
    description,
    `<button type="button" class="settings-switch" role="switch" aria-checked="${settingsDraft[key]}" aria-label="${title}" data-setting-toggle="${key}"><span></span></button>`,
  );
}
function settingsContent() {
  if (settingsSection === "general")
    return `<div class="settings-group-label">让工作台更适合你</div>${settingsRow("外观", "选择浅色、深色，或跟随系统外观。", settingsChoice("theme-choice", "外观", "theme", [choice("light", "浅色"), choice("dark", "深色"), choice("system", "跟随系统")]))}${settingSwitch("motion", "界面动画", "展开、收起与页面切换采用轻量过渡；尊重系统的减少动态效果设置。")}${settingsRow("默认模型", "新任务默认使用的模型，可在输入栏单独更换。", settingsChoice("default-model", "新任务默认模型", "model", [choice("Qwen"), choice("DeepSeek")]))}<div class="settings-note">快捷键 <kbd>Ctrl + N</kbd> 新建任务 · <kbd>Ctrl + K</kbd> 搜索任务</div>`;
  if (settingsSection === "models")
    return `<p class="settings-intro">服务地址、凭据和模型能力统一管理。日常任务里只需选择模型与思考等级。</p>${["Qwen", "DeepSeek"].map((name) => `<div class="service-row"><span class="service-icon">${icon("spark")}</span><div><strong>${name}</strong><small>示例模型配置</small></div><span class="sample-tag">提案示例</span></div>`).join("")}<div class="settings-note">思考等级和上下文容量的真实值，接入时以模型能力和实际用量为准。不支持或未知时明确提示。</div>`;
  if (settingsSection === "permissions")
    return `${settingsRow("新任务默认权限", "工作模式与权限分别生效，聊天模式不会因为完全访问而开始修改。", settingsChoice("default-permission", "新任务默认权限", "permission", [choice("请求审批", "请求审批", "重要操作交给你确认"), choice("帮我批准", "帮我批准", "不确定的操作仍由你决定"), choice("完全访问", "完全访问", "在系统与服务已有权限内执行")]))}<div class="settings-note">权限始终显示在输入栏左侧。对具体操作的批准仍需要绑定对应任务、对象和范围。</div>`;
  if (settingsSection === "notifications")
    return `${settingSwitch("inApp", "软件内通知", "在右上角通知入口查看需要处理的事项。")}${settingSwitch("system", "Windows 系统通知", "窗口不在前台时，提醒完成、失败或需要确认。")}${settingSwitch("tray", "托盘提示", "隐藏窗口后仍能注意到待处理事项。")}<div class="settings-note">这里是提案开关，不会更改系统通知权限或正式应用设置。</div>`;
  if (settingsSection === "connections")
    return `<p class="settings-intro">浏览器属于工作工具。接入方式与授权集中管理，具体网页在任务工作区打开。</p>${[
      ["专用浏览器", "WorkPilot 独立资料目录"],
      ["Chrome", "使用你明确授权的页面"],
      ["Edge", "使用你明确授权的页面"],
    ]
      .map(
        ([title, copy]) =>
          `<div class="service-row"><span class="service-icon">${icon("globe")}</span><div><strong>${title}</strong><small>${copy}</small></div><span class="sample-tag">未连接</span></div>`,
      )
      .join(
        "",
      )}<div class="settings-note">此提案不会连接真实浏览器或读取登录资料。</div>`;
  if (settingsSection === "memory")
    return `<p class="settings-intro">值得长期记住的要求，先由助手提出，再由你确认保存。</p><div class="memory-example"><small>项目 · WorkPilot · 示例内容</small><p>回复简洁，先说明结果，再给出必要细节。</p></div><div class="settings-note">正式接入继续支持候选确认、范围区分、版本和删除；不在提案中写入真实记忆。</div>`;
  return `<p class="settings-intro">数据和维护操作按用途分组，不打断正在进行的工作。</p>${[
    ["迁移与导出", "选择项目、任务及资料，先预览范围，再导出。"],
    ["备份与恢复", "查看已保存的备份和恢复范围。"],
    ["安装与更新", "由你决定何时安装，更新前检查数据副本。"],
    ["本地诊断", "记录保存在本机，主动选择需要导出的内容。"],
  ]
    .map(
      ([title, copy]) =>
        `<details class="settings-detail"><summary>${icon("folder")}<span>${title}</span>${icon("chevron-right")}</summary><div><p>${copy}</p><small>此处展示页面分组，正式操作沿用已有确认流程。</small></div></details>`,
    )
    .join("")}`;
}
function showSettings(section = "general") {
  if (typeof section !== "string") section = "general";
  settingsDraft = {
    ...savedSettings,
    model: state.model,
    permission: state.permission,
  };
  settingsSection = settingsSections.some(([id]) => id === section)
    ? section
    : "general";
  closeMenu(false);
  const dialog = $("dialog");
  dialog.className = "settings-dialog";
  dialog.setAttribute("aria-label", "设置");
  $("dialog-body").innerHTML =
    `<div class="settings-layout"><aside class="settings-navigation"><h2>设置</h2><nav aria-label="设置目录">${settingsSections.map(([id, title, glyph]) => `<button data-settings-section="${id}" aria-label="${title}">${icon(glyph)}<span>${title}</span></button>`).join("")}</nav><div class="settings-brand"><img src="../../assets/icons/png/128.png" alt="" />WorkPilot <small>交互提案</small></div></aside><section class="settings-main"><header><div><h3 id="settings-title"></h3><p>为你的工作方式调整细节</p></div><button class="icon-button" data-action="close-dialog" aria-label="关闭设置">${icon("close")}</button></header><div class="settings-scroll" id="settings-content"></div><footer><span>仅作用于当前提案</span><button class="solid-button" data-action="save-settings">保存设置</button></footer></section></div>`;
  renderSettings(false);
  Motion.openDialog(dialog);
  dialog.querySelector(`[data-settings-section="${settingsSection}"]`)?.focus();
}
function renderSettings(animate = true) {
  $("settings-title").textContent = settingsSections.find(
    ([id]) => id === settingsSection,
  )[1];
  document.querySelectorAll("[data-settings-section]").forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.settingsSection === settingsSection,
    );
    button.setAttribute(
      "aria-current",
      button.dataset.settingsSection === settingsSection ? "page" : "false",
    );
  });
  const content = $("settings-content");
  if (animate) Motion.replace(content, settingsContent(), settingsSection);
  else {
    content.innerHTML = settingsContent();
    content.dataset.viewKey = settingsSection;
  }
}
function saveSettings() {
  savedSettings = { ...settingsDraft };
  const dark =
    savedSettings.theme === "dark" ||
    (savedSettings.theme === "system" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.classList.toggle("dark", dark);
  document.body.classList.toggle("reduce-motion", !savedSettings.motion);
  state.model = savedSettings.model;
  state.permission = savedSettings.permission;
  renderComposer();
  Motion.closeDialog($("dialog"));
  toast("已保存当前提案的设置");
}
document.addEventListener("click", (event) => {
  const section = event.target.closest("[data-settings-section]");
  if (section) {
    settingsSection = section.dataset.settingsSection;
    renderSettings();
    $("settings-content").scrollTop = 0;
  }
  const toggle = event.target.closest("[data-setting-toggle]");
  if (toggle) {
    const key = toggle.dataset.settingToggle;
    settingsDraft[key] = !settingsDraft[key];
    toggle.setAttribute("aria-checked", String(settingsDraft[key]));
  }
});
