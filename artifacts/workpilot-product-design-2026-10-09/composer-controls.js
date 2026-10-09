function bindMenu(id, title, options) {
  const button = $(id);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menuAnchor === button && !$("popover").hidden) closeMenu();
    else showMenu(button, title, options());
  });
}
const thinkingLevels = [
  { value: "low", label: "低", description: "适合简单整理，优先快速响应" },
  { value: "medium", label: "中", description: "兼顾推敲程度与响应速度" },
  { value: "high", label: "高", description: "适合复杂问题，通常需要更长时间" },
];
function updateComposerExtras() {
  const level = thinkingLevels.find((item) => item.value === state.effort);
  $("thinking-label").textContent = `思考：${level.label}`;
  const used = state.screen === "new" ? 0 : 46080;
  const percent = PreviewModel.context(used, 128000);
  const ring = $("context-ring");
  ring.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="context-track" cx="12" cy="12" r="8.5"/><circle class="context-used" cx="12" cy="12" r="8.5" pathLength="100" stroke-dasharray="${percent} 100" transform="rotate(-90 12 12)"/></svg>`;
  ring.setAttribute("aria-label", `上下文已使用 ${percent}%（示例），查看详情`);
  ring.title = `上下文已使用 ${percent}% · 示例数据`;
}
function updateDemoState() {
  const options = [
    { value: "running", label: "进行中", glyph: "clock" },
    { value: "approval", label: "需要审批", glyph: "shield" },
    { value: "completed", label: "已完成", glyph: "check" },
    { value: "interrupted", label: "已中断", glyph: "stop" },
    { value: "new", label: "新任务", glyph: "plus" },
  ];
  dropdownFields.set("demo-state", {
    label: "切换演示状态",
    value: state.screen,
    options,
    onChange: (screen) => {
      rememberTask();
      state.notes = [];
      state.queue = [];
      state.attachments = [];
      state.title = previewTasks.design.title;
      state.taskId = screen === "new" ? null : "design";
      previewTasks.design.archived = false;
      state.project = "WorkPilot";
      switchScreen(screen);
    },
  });
  $("demo-state").innerHTML =
    `<span>${options.find((option) => option.value === state.screen).label}</span>${icon("chevron-down")}`;
}
function showContext() {
  const used = state.screen === "new" ? 0 : 46080;
  const percent = PreviewModel.context(used, 128000);
  const popup = placeSurface(
    $("context-ring"),
    "上下文窗口",
    `<div class="context-card"><div class="context-amount"><strong>${percent}%</strong><span>已使用</span></div><div class="context-meter"><span style="width:${percent}%"></span></div><p>${used.toLocaleString()} / 128,000 <span>tokens</span></p><small>用于衡量这次对话可容纳的内容。这里是示例数值，真实容量与用量接入模型后显示。</small><button class="outline-button" id="context-close">知道了</button></div>`,
    null,
    "dialog",
  );
  popup.querySelector("#context-close").onclick = () => closeMenu();
  popup.querySelector("button").focus();
}
function showScheduleDraft() {
  let repeat = "weekly";
  const choices = [
    { value: "weekly", label: "每周五 17:30", description: "按本机时区执行" },
    { value: "daily", label: "每天 09:00", description: "按本机时区执行" },
  ];
  const field = () =>
    dropdown("repeat-frequency", "重复时间", repeat, choices, (value) => {
      repeat = value;
      $("repeat-field").innerHTML = field();
    });
  showDialog(
    "新建计划",
    `<p>先安排工作内容与时间，再确认它使用的项目和权限。</p><label>任务要求<input id="schedule-goal" placeholder="例如：汇总本周项目进展" /></label><div class="field-label">重复时间<div id="repeat-field">${field()}</div></div><div class="notice">项目：WorkPilot · 权限：请求审批<br />本提案不会创建真实定时任务。</div><div class="button-row"><button class="solid-button" data-action="save-schedule">查看保存反馈</button></div>`,
  );
}
bindMenu("model-menu", "选择模型 · 示例配置", () =>
  ["Qwen", "DeepSeek"]
    .map((label) => ({
      label,
      glyph: "spark",
      checked: state.model === label,
      run: () => {
        state.model = label;
        renderComposer();
      },
    }))
    .concat([
      {
        label: "管理模型服务",
        glyph: "settings",
        run: () => showSettings("models"),
      },
    ]),
);
bindMenu("mode-menu", "工作模式", () =>
  [
    ["聊天", "讨论和理解，不开始实质修改", "chat"],
    ["先规划再执行", "先确定计划，再开始执行", "files"],
    ["直接执行", "在有效权限内直接推进工作", "play"],
  ].map(([label, description, glyph]) => ({
    label,
    description,
    glyph,
    checked: state.mode === label,
    run: () => {
      state.mode = label;
      renderComposer();
    },
  })),
);
bindMenu("permission-menu", "任务权限", () =>
  [
    ["请求审批", "重要操作交给你确认"],
    ["帮我批准", "独立审查，不确定时询问你"],
    ["完全访问", "在系统与服务已有权限内执行"],
  ].map(([label, description]) => ({
    label,
    description,
    glyph: "shield",
    checked: state.permission === label,
    run: () => {
      state.permission = label;
      renderComposer();
      toast(`示例权限已设为${label}`);
    },
  })),
);
bindMenu("thinking-menu", "思考等级 · 示例", () =>
  thinkingLevels.map(({ value, label, description }) => ({
    label,
    description,
    glyph: "spark",
    checked: state.effort === value,
    run: () => {
      state.effort = value;
      renderComposer();
    },
  })),
);
$("context-ring").onclick = (event) => {
  event.stopPropagation();
  if (menuAnchor === $("context-ring") && !$("popover").hidden) closeMenu();
  else showContext();
};
