const $ = (id) => document.getElementById(id);
const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const state = {
  page: "tasks",
  screen: "running",
  title: "重做产品工作台",
  project: "WorkPilot",
  panel: "artifacts",
  selectedFile: 0,
  queue: [],
  attachments: [],
  notes: [],
  panelOpen: innerWidth >= 1250,
  mode: "直接执行",
  model: "Qwen",
  permission: "请求审批",
  effort: "medium",
  taskId: "design",
};
const files = [
  {
    name: "工作台结构.md",
    info: "页面分工与入口层级 · 2.4 KB",
    title: "把当前任务放在中心",
    section: "01 / 工作台结构",
    copy: "项目帮助你组织工作。对话承载目标与反馈。成果在需要时展开，始终留在当前任务旁。",
  },
  {
    name: "核心交互.md",
    info: "新建、运行、审批与恢复 · 3.1 KB",
    title: "每一步都有明确的下一步",
    section: "02 / 核心交互",
    copy: "输入即开始；运行时可补充、排队或引导；审批说明具体影响；出错后保留上下文和恢复入口。",
  },
  {
    name: "页面检查清单.md",
    info: "布局、状态与可访问性 · 1.8 KB",
    title: "好用，需要逐页验证",
    section: "03 / 体验标准",
    copy: "布局有主次，按钮随情境出现。键盘可操作，窗口缩小也能完成任务。任何状态都不让用户猜。",
  },
];
const people = `<div class="collaborators"><button data-action="team"><span class="initial">结</span>结构分析 ${icon("check")}</button><button data-action="team"><span class="initial">交</span>交互梳理 <span class="spinner"></span></button></div>`;
function fileRows() {
  return files
    .map(
      (file, index) =>
        `<button class="result-row" data-file="${index}"><span class="file-icon">${icon("files")}</span><span><strong>${file.name}</strong><small>${file.info}</small></span>${icon("chevron-right")}</button>`,
    )
    .join("");
}
function steps() {
  return `<details class="step-summary"><summary>${icon("check")}已查看 4 份资料 · 完成 3 个步骤 ${icon("chevron-right")}</summary><div class="step-list"><div>${icon("check")}阅读当前工作台结构<code>4 份资料</code></div><div>${icon("check")}梳理入口与高频操作<code>13 个入口</code></div><div>${icon("check")}整理布局与任务流程<code>2 位助手</code></div><button class="menu-row" data-action="activity">查看完整执行过程 ${icon("chevron-right")}</button></div></details>`;
}
function approvalCard() {
  return `<section class="approval" aria-label="修改文件审批"><div class="approval-title">${icon("shield")}需要你确认一次文件修改</div><p>将保存 3 份工作台设计文档，供你查看与修改。</p><div class="approval-scope">${icon("folder")}WorkPilot / docs <span class="muted">· 新建 3 个文件，不覆盖已有文件</span></div><details><summary>查看文件与具体操作</summary><pre>新增 docs/工作台结构.md\n新增 docs/核心交互.md\n新增 docs/页面检查清单.md\n\n范围：当前项目。无网络发送。</pre></details><div class="button-row"><button class="solid-button" data-action="approve">批准这次修改</button><button class="outline-button" data-action="reject">拒绝</button></div></section>`;
}
function renderTask() {
  if (state.screen === "new") {
    return `<section class="new-work"><img class="welcome-mark" src="../../assets/icons/png/128.png" alt="" /><h2>开始一项新工作</h2><p>描述目标，添加资料，剩下的一起完成。</p><div class="suggestions"><button data-prompt="帮我梳理这个项目的结构，给出一份改进计划。">${icon("folder")}理解一个项目 ${icon("chevron-right")}</button><button data-prompt="整理我提供的资料，提取要点和需要跟进的事项。">${icon("files")}整理资料与要点 ${icon("chevron-right")}</button><button data-prompt="根据需求制作一份清晰的文档，并保留可编辑的源文件。">${icon("edit")}制作一份文档 ${icon("chevron-right")}</button></div></section>`;
  }
  const initial =
    state.title === "重做产品工作台"
      ? "重新梳理 WorkPilot 的界面和操作流程。以当前任务为中心，让开始工作、查看进度和处理成果都更自然。"
      : `请帮我${state.title}，保留清晰的过程和可继续使用的成果。`;
  let body = "";
  if (state.notes.length) {
    body = `<p>已收到新的要求。</p><div class="notice">这是交互提案中的示例状态。可以试着追加消息、引导、停止，或从顶部切换到审批与完成状态。</div>`;
  } else {
    body = `<p>我会先理清工作台的结构，再梳理从开始到交付的关键操作。</p>${steps()}<p>当前的问题主要在于：功能入口与正在进行的工作争抢注意力，操作之间也缺少清晰的先后关系。</p><h2>把工作台分成三个有明确分工的区域</h2><ol><li><strong>左侧，找到工作。</strong> 按项目组织任务，快速切换和搜索。</li><li><strong>中间，推进工作。</strong> 对话、进度和需要你处理的事项都在这里。</li><li><strong>右侧，查看结果。</strong> 按需展开文件、成果和完整过程。</li></ol>`;
  }
  if (state.screen === "running")
    body += `${people}<div class="working-line"><span class="spinner"></span>正在整理核心交互与页面检查清单…</div>`;
  if (state.screen === "approval") body += approvalCard();
  if (state.screen === "completed")
    body += `<p>已整理为 3 份文档，点击即可在旁边查看。</p><div class="result-list">${fileRows()}</div><p class="muted">你可以继续补充要求，或打开任一文档讨论具体修改。</p>`;
  if (state.screen === "interrupted")
    body += `<div class="notice"><strong>任务已中断</strong><br />已有对话和成果保留。你可以调整要求，再手动继续。</div><button class="outline-button" data-action="resume">${icon("play")} 继续任务</button>`;
  return `<div class="user-message">${escapeHtml(state.notes[0] || initial)}</div><div class="assistant-header"><img src="../../assets/icons/png/128.png" alt="" />WorkPilot <time>刚刚</time></div><article class="assistant-message">${body}</article>${state.notes
    .slice(1)
    .map((note) => `<div class="user-message">${escapeHtml(note)}</div>`)
    .join("")}`;
}
function renderCollection() {
  if (state.page === "library")
    return `<p class="page-intro">与任务有关的文档、图片和其它成果，集中保存在这里。</p><div class="page-toolbar"><h2>最近的成果</h2><button class="outline-button" data-action="attach-library">添加资料</button></div><div class="result-list">${fileRows()}</div><p class="panel-meta">当前展示 WorkPilot 项目的示例成果。真实文件仍由原文件系统管理。</p>`;
  if (state.page === "skills")
    return `<p class="page-intro">让助手使用你熟悉的工作方法，并连接需要的工具。</p><div class="page-toolbar"><h2>我的技能</h2><button class="solid-button" data-action="create-skill">创建技能</button></div>${[
      ["files", "文档整理", "从资料中提取要点，整理为可编辑的文档。"],
      ["terminal", "项目检查", "检查代码变化，并汇总需要关注的问题。"],
      ["spark", "技能创建指导", "把你的工作方法整理为待确认的技能。"],
    ]
      .map(
        ([glyph, title, copy]) =>
          `<div class="collection-row">${icon(glyph)}<div><h3>${title}</h3><p>${copy}</p></div><button class="outline-button" data-skill="${title}">查看</button></div>`,
      )
      .join(
        "",
      )}<h2 style="font-size:15px;margin-top:34px">工具连接</h2><div class="collection-row">${icon("globe")}<div><h3>浏览器</h3><p>专用浏览器，或你已授权的 Chrome 与 Edge。</p></div><button class="outline-button" data-action="browser-setup">管理</button></div>`;
  return `<p class="page-intro">为重复工作安排时间。关闭窗口后继续运行，彻底退出后停止。</p><div class="page-toolbar"><h2>我的计划</h2><button class="solid-button" data-action="create-schedule">新建计划</button></div><div class="collection-row">${icon("clock")}<div><h3>整理本周项目进展</h3><p>每周五 17:30 · WorkPilot · 需要审批时等待确认</p></div><button class="outline-button" data-action="schedule-detail">查看计划</button></div><div class="notice">定时执行也遵守你设置的权限。每次运行会创建独立任务，便于查看结果。</div>`;
}
function render() {
  rememberTask();
  syncTaskList();
  const isTask = state.page === "tasks";
  document
    .querySelectorAll("[data-page]")
    .forEach((button) =>
      button.classList.toggle("selected", button.dataset.page === state.page),
    );
  $("task-title").textContent = isTask
    ? state.screen === "new"
      ? "新任务"
      : state.title
    : { library: "资料库", skills: "技能与连接", schedules: "定时任务" }[
        state.page
      ];
  $("breadcrumb").innerHTML =
    `${escapeHtml(state.project)} <span>/</span> ${isTask ? "任务" : "工作空间"}`;
  const statuses = {
    running: ["进行中", ""],
    approval: ["需要审批", "waiting"],
    completed: ["已完成", ""],
    interrupted: ["已中断", "paused"],
    new: ["", ""],
  };
  const [label, cls] = statuses[state.screen];
  $("task-status").className = `status-badge ${cls}`;
  $("task-status").innerHTML =
    !isTask || !label
      ? ""
      : `${state.screen === "running" ? '<span class="spinner"></span>' : icon(state.screen === "completed" ? "check" : state.screen === "approval" ? "shield" : "stop")}${label}`;
  $("composer-area").hidden = !isTask;
  $("workspace-open").hidden = !isTask && state.page !== "library";
  Motion.replace(
    $("conversation"),
    isTask ? renderTask() : renderCollection(),
    `${state.page}:${state.taskId}:${state.title}:${state.screen}`,
  );
  updateDemoState();
  $("message").placeholder =
    state.screen === "new"
      ? "你想完成什么？可以附上文件或图片…"
      : "补充要求，或把文件拖到这里…";
  $("compose-hint").textContent = ["running", "approval"].includes(state.screen)
    ? "运行时发送的要求会排队，可选择立即引导"
    : state.screen === "interrupted"
      ? "中断后由你决定何时继续"
      : "当前项目：" + state.project;
  renderComposer();
  renderPanel();
}
function renderComposer() {
  const filled = !!$("message").value.trim();
  const running = ["running", "approval"].includes(state.screen);
  const stop = running && !filled;
  const resume = state.screen === "interrupted" && !filled;
  $("send").innerHTML = icon(stop ? "stop" : resume ? "play" : "arrow");
  $("send").setAttribute(
    "aria-label",
    stop ? "停止任务" : resume ? "继续任务" : running ? "加入队列" : "发送要求",
  );
  $("send").disabled = !filled && !stop && !resume;
  $("queue-list").innerHTML = state.queue
    .map(
      (message, index) =>
        `<div class="queue-item"><small>待处理</small><span>${escapeHtml(message)}</span><button data-steer="${index}">立即引导</button><button class="icon-button" data-cancel="${index}" aria-label="取消这条排队消息">${icon("close")}</button></div>`,
    )
    .join("");
  $("attachment-list").innerHTML = state.attachments
    .map(
      (file, index) =>
        `<div class="attachment-chip">${icon("files")}<span>${escapeHtml(file.name)}</span><button type="button" data-remove="${index}" aria-label="移除 ${escapeHtml(file.name)}">${icon("close")}</button></div>`,
    )
    .join("");
  $("model-label").textContent = state.model;
  $("mode-label").textContent = state.mode;
  $("permission-label").textContent = state.permission;
  updateComposerExtras();
  rememberTask();
}
function renderPanel() {
  syncPanelVisibility();
  const panelKey = `${state.panel}:${state.selectedFile}:${state.screen}`;
  const previousKey = $("panel-content").dataset.viewKey;
  $("panel-content").dataset.viewKey = panelKey;
  $("workspace-open").setAttribute("aria-expanded", String(state.panelOpen));
  document
    .querySelectorAll("[data-panel]")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.panel === state.panel),
    );
  if (state.panel === "files") {
    $("panel-content").innerHTML =
      `<h2>项目文件</h2><div class="panel-caption">WorkPilot · 当前任务可访问的项目</div><div class="tree-row">${icon("folder")}docs</div>${files.map((file, index) => `<button class="tree-row indented" data-file="${index}">${icon("files")}${file.name}</button>`).join("")}<div class="tree-row">${icon("folder")}src</div><div class="tree-row">${icon("files")}README.md</div><div class="button-row" style="margin-top:24px"><button class="outline-button" data-action="terminal">${icon("terminal")} 终端</button><button class="outline-button" data-action="browser">${icon("globe")} 浏览器</button></div>`;
  } else if (state.panel === "activity") {
    $("panel-content").innerHTML =
      `<h2>执行过程</h2><p class="panel-caption">当前任务 · 示例记录</p>${[
        [
          "阅读项目资料",
          "查看 4 份文档，了解现有工作台。",
          "read_file",
          '{"path":"docs/README.md"}',
        ],
        [
          "结构分析助手完成",
          "梳理入口分组，交付布局建议。",
          "assistant_result",
          "已完成入口与功能归属分析。",
        ],
        [
          "交互梳理助手",
          state.screen === "completed"
            ? "已交付交互流程与检查清单。"
            : "正在整理运行、审批与恢复流程。",
          "assistant_status",
          state.screen,
        ],
      ]
        .map(
          ([title, copy, name, detail]) =>
            `<div class="timeline-item"><h4>${title}</h4><p>${copy}</p><details><summary>查看具体记录</summary><pre>${name}\n${escapeHtml(detail)}</pre></details></div>`,
        )
        .join(
          "",
        )}<button class="outline-button" data-action="records">查找与导出完整记录</button>`;
  } else {
    const file = files[state.selectedFile];
    $("panel-content").innerHTML =
      `<h2>${file.name}</h2><div class="panel-caption">${state.screen === "completed" ? "当前任务的成果" : "草稿预览"} · 示例文档</div><button class="outline-button" data-action="download-sample">${icon("download")} 下载示例</button><article class="paper"><span class="document-eyebrow">WORKPILOT / PRODUCT NOTES</span><h3>${file.title}</h3><p>${file.section}</p><h4>设计原则</h4><p>${file.copy}</p><h4>清晰的层级</h4><ol><li>优先呈现当前工作。</li><li>需要时再出现具体操作。</li><li>过程可追溯，成果可继续使用。</li></ol><h4>接下来需要落实</h4><p>新建、运行、审批、错误与恢复使用一致的界面规则。</p><span class="document-line"></span><span class="document-line"></span><span class="document-line short"></span></article><div class="panel-meta">原型示例，未读取或修改本机项目文件。</div><h3 style="font-size:11px;font-weight:500;margin-top:28px;color:var(--muted)">其它成果</h3>${files
        .filter((_, index) => index !== state.selectedFile)
        .map(
          (other) =>
            `<button class="result-row" data-file="${files.indexOf(other)}">${icon("files")}<strong>${other.name}</strong>${icon("chevron-right")}</button>`,
        )
        .join("")}`;
  }
  if (state.panelOpen && previousKey !== panelKey)
    Motion.enter($("panel-content"));
}
function switchScreen(screen) {
  rememberTask();
  state.page = "tasks";
  state.screen = screen;
  if (screen === "new") {
    state.taskId = null;
    state.notes = [];
    state.queue = [];
    state.attachments = [];
    state.panelOpen = false;
    $("message").value = "";
  }
  render();
}
function openPanel(panel = "artifacts") {
  state.panel = panel;
  state.panelOpen = true;
  renderPanel();
}
let toastTimer;
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 3300);
}
