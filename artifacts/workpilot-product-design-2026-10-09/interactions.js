function attachFiles(list) {
  const incoming = Array.from(list).slice(0, 12 - state.attachments.length);
  state.attachments.push(...incoming.map(({ name, size }) => ({ name, size })));
  renderComposer();
  if (incoming.length) toast("已加入示例附件；提案不会上传或读取文件内容");
}
const actions = {
  "close-dialog": () => Motion.closeDialog($("dialog")),
  activity: () => openPanel("activity"),
  team: () =>
    showDialog(
      "协作成员",
      `<p>主助手负责安排与汇总。每位成员的职责、模型和交付都可单独查看。</p><div class="collection-row">${icon("check")}<div><h3>结构分析 · 已完成</h3><p>梳理入口层级，交付工作台结构建议 · Qwen</p></div></div><div class="collection-row">${icon("clock")}<div><h3>交互梳理 · 进行中</h3><p>整理任务从开始到交付的流程 · DeepSeek</p></div></div><div class="button-row"><button class="outline-button" data-action="team-activity">查看成员过程</button></div>`,
    ),
  "team-activity": () => {
    Motion.closeDialog($("dialog"));
    openPanel("activity");
  },
  approve: () => {
    switchScreen("running");
    toast("示例审批已确认，任务回到进行中");
  },
  reject: () => {
    switchScreen("interrupted");
    toast("已拒绝示例操作，未修改任何文件");
  },
  resume: () => {
    switchScreen("running");
    toast("示例任务继续运行");
  },
  records: () =>
    showDialog(
      "完整记录",
      `<p>完整记录保留工具输入、输出、成员来源与错误；日常对话仅展示必要摘要。</p><label>查找记录<input id="record-search" placeholder="输入工具名或关键词" /></label><div class="step-list"><div>${icon("check")}read_file · 阅读 4 份项目文档</div><div>${icon("check")}assistant_result · 结构分析已交付</div><div>${icon("clock")}assistant_status · 交互梳理进行中</div></div><div class="button-row"><button class="outline-button" data-action="download-records">导出示例记录</button></div>`,
    ),
  terminal: () =>
    showDialog(
      "终端",
      `<p>终端将与当前项目和运行进程绑定，退出与停止继续遵守原有规则。</p><div class="notice"><code>WorkPilot &gt;</code><br />此处是交互位置提案，没有启动命令进程。</div>`,
    ),
  browser: () =>
    showDialog(
      "浏览器",
      `<p>在任务旁打开网页。专用浏览器和已授权的日常浏览器分别管理。</p><div class="collection-row">${icon("globe")}<div><h3>专用浏览器</h3><p>使用 WorkPilot 独立浏览器资料。</p></div></div><div class="collection-row">${icon("shield")}<div><h3>日常 Chrome / Edge</h3><p>需要用户授权后连接，不自动取得已有登录内容。</p></div></div>`,
    ),
  "browser-setup": () => actions.browser(),
  "attach-library": () => $("file-input").click(),
  "create-skill": () => {
    Motion.closeDialog($("dialog"));
    switchScreen("new");
    $("message").value =
      "帮我把一种工作方法整理成技能，先展示草稿，等我确认再启用。";
    renderComposer();
    $("message").focus();
  },
  "create-schedule": showScheduleDraft,
  "save-schedule": () => {
    if (!$("schedule-goal").value.trim()) {
      $("schedule-goal").focus();
      toast("先填写希望完成的工作");
      return;
    }
    Motion.closeDialog($("dialog"));
    toast("示例计划已保存；没有安排真实执行");
  },
  "schedule-detail": () =>
    showDialog(
      "整理本周项目进展",
      `<p>每周五 17:30 · WorkPilot · 请求审批</p><div class="notice">读取本周项目记录，汇总已完成工作、待办和需要关注的问题。</div><div class="button-row"><button class="outline-button" data-action="close-dialog">返回计划</button><button class="solid-button" data-action="schedule-preview">查看任务示例</button></div>`,
    ),
  "schedule-preview": () => {
    Motion.closeDialog($("dialog"));
    rememberTask();
    startPreviewTask("整理本周项目进展");
    state.notes = [];
    switchScreen("running");
  },
  "model-settings": () => showSettings("models"),
  settings: showSettings,
  "data-settings": () => showSettings("data"),
  "save-settings": saveSettings,
  "open-approval": () => {
    Motion.closeDialog($("dialog"));
    rememberTask();
    if (previewTasks.design.archived) {
      toast("这条示例任务已归档");
      return;
    }
    state.taskId = "design";
    state.title = previewTasks.design.title;
    state.project = previewTasks.design.project;
    state.notes = [];
    switchScreen("approval");
    document.querySelector(".approval")?.scrollIntoView({ block: "center" });
  },
  "download-sample": () =>
    download(
      `${files[state.selectedFile].name}`,
      `# 示例文档：${files[state.selectedFile].title}\n\n这是 WorkPilot 工作台交互提案的示例内容，不是引擎生成成果。\n\n${files[state.selectedFile].copy}\n`,
    ),
  "download-records": () =>
    download(
      "示例执行记录.txt",
      "WorkPilot 交互提案：示例记录，不是真实任务日志。\nread_file：查看项目资料\nassistant_result：结构分析交付\n",
    ),
};
function download(name, text) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("已下载提案中的示例内容");
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!$("popover").contains(event.target)) {
    closeMenu(false);
  }
  if (!button) return;
  if (button.dataset.action) actions[button.dataset.action]?.();
  if (button.dataset.task) chooseTask(button.dataset.task);
  if (button.dataset.file !== undefined) {
    state.selectedFile = Number(button.dataset.file);
    openPanel("artifacts");
  }
  if (button.dataset.panel) openPanel(button.dataset.panel);
  if (button.dataset.page) {
    rememberTask();
    state.page = button.dataset.page;
    state.panelOpen = false;
    render();
  }
  if (button.dataset.prompt) {
    $("message").value = button.dataset.prompt;
    renderComposer();
    $("message").focus();
  }
  if (button.dataset.skill)
    showDialog(
      button.dataset.skill,
      `<p>技能详情把用途、适用项目、授权与版本放在一起。</p><div class="notice">当前是页面组织提案。正式版本继续沿用已有技能草稿、确认启用、更新与回退能力。</div><div class="button-row"><button class="outline-button" data-action="close-dialog">返回技能列表</button><button class="solid-button" data-action="create-skill">讨论这个技能</button></div>`,
    );
  if (button.dataset.steer !== undefined) {
    const [message] = state.queue.splice(Number(button.dataset.steer), 1);
    state.notes.push(message);
    render();
    toast("示例消息已设为引导，展示在当前任务中");
  }
  if (button.dataset.cancel !== undefined) {
    state.queue.splice(Number(button.dataset.cancel), 1);
    renderComposer();
    toast("已取消这条排队消息");
  }
  if (button.dataset.remove !== undefined) {
    state.attachments.splice(Number(button.dataset.remove), 1);
    renderComposer();
  }
});
$("composer").onsubmit = (event) => {
  event.preventDefault();
  const message = $("message").value.trim();
  if (!message) {
    if (["running", "approval"].includes(state.screen))
      switchScreen("interrupted");
    else if (state.screen === "interrupted") switchScreen("running");
    return;
  }
  if (["running", "approval"].includes(state.screen)) {
    state.queue.push(message);
    toast("已加入示例队列，可点击立即引导");
  } else {
    if (state.screen === "new") startPreviewTask(message.slice(0, 24));
    state.notes.push(message);
    state.screen = "running";
  }
  $("message").value = "";
  $("message").style.height = "";
  state.attachments = [];
  render();
};
$("message").oninput = () => {
  $("message").style.height = "auto";
  $("message").style.height = `${Math.min($("message").scrollHeight, 132)}px`;
  renderComposer();
};
$("message").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if ($("message").value.trim() && !$("send").disabled)
      $("composer").requestSubmit();
  }
};
$("message").onpaste = (event) => {
  if (event.clipboardData.files.length) {
    event.preventDefault();
    attachFiles(event.clipboardData.files);
  }
};
$("composer").ondragover = (event) => {
  event.preventDefault();
  $("composer").classList.add("dragging");
};
$("composer").ondragleave = () => $("composer").classList.remove("dragging");
$("composer").ondrop = (event) => {
  event.preventDefault();
  $("composer").classList.remove("dragging");
  attachFiles(event.dataTransfer.files);
};
$("attach").onclick = () => $("file-input").click();
$("file-input").onchange = () => {
  attachFiles($("file-input").files);
  $("file-input").value = "";
};
$("new-task").onclick = () => {
  switchScreen("new");
  $("message").focus();
};
$("search-open").onclick = showSearch;
$("settings-open").onclick = showSettings;
$("workspace-open").onclick = () => {
  state.panelOpen = !state.panelOpen;
  renderPanel();
};
$("panel-close").onclick = () => {
  state.panelOpen = false;
  renderPanel();
};
$("collapse-sidebar").onclick = () => setSidebar(false);
$("restore-sidebar").onclick = () =>
  setSidebar(
    innerWidth > 620 || !$("shell").classList.contains("sidebar-mobile-open"),
  );
$("project-toggle").onclick = () => {
  const open = $("project-toggle").getAttribute("aria-expanded") !== "true";
  $("project-toggle").setAttribute("aria-expanded", String(open));
  Motion.region($("project-tasks"), open);
};
$("personal-project").onclick = () => {
  rememberTask();
  state.taskId = null;
  state.project = "个人工作";
  switchScreen("new");
};
$("add-project").onclick = () => {
  showDialog(
    "新建项目",
    `<p>项目把相关任务、资料和规则放在一起。文件夹授权在实际接入时单独确认。</p><label>项目名称<input id="project-name" placeholder="例如：个人笔记" /></label><div class="button-row"><button class="solid-button" id="project-save">创建示例项目</button></div>`,
  );
  $("project-save").onclick = () => {
    const name = $("project-name").value.trim();
    if (!name) {
      $("project-name").focus();
      return;
    }
    rememberTask();
    state.taskId = null;
    state.project = name;
    Motion.closeDialog($("dialog"));
    switchScreen("new");
  };
};
$("notifications-open").onclick = () =>
  showDialog(
    "通知",
    `<div class="notification-item">${icon("shield")}<div><strong>重做产品工作台 · 需要审批</strong><p>准备保存 3 份设计文档。查看具体范围后再决定。</p><button class="outline-button" data-action="open-approval">前往任务处理</button></div></div><p>通知只帮助你定位任务；批准或拒绝在任务中的具体审批上完成。</p>`,
  );
for (const dialog of [$("dialog"), $("search-dialog")]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) Motion.closeDialog(dialog);
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!$("popover").hidden) closeMenu();
    else Motion.closeDialog(dialog);
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenu(false);
    if (innerWidth <= 620) setSidebar(false);
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    showSearch();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    Motion.closeDialog($("search-dialog"));
    Motion.closeDialog($("dialog"), () => $("message").focus());
    switchScreen("new");
  }
});
paintIcons();
initWorkspaceControls();
render();
