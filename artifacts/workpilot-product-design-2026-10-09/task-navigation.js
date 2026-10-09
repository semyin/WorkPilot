const previewTasks = structuredClone(PreviewModel.tasks);
let searchIndex = 0;
let searchMatches = [];
function rememberTask() {
  if (!state.taskId || state.screen === "new" || state.page !== "tasks") return;
  const existing = previewTasks[state.taskId] || {};
  previewTasks[state.taskId] = {
    ...existing,
    title: state.title,
    project: state.project,
    screen: state.screen,
    notes: [...state.notes],
    queue: [...state.queue],
    draft: $("message").value,
    time: existing.time || "现在",
  };
}
function syncTaskList() {
  document.querySelectorAll(".task-link[data-task]").forEach((button) => {
    const task = previewTasks[button.dataset.task];
    if (!task) return;
    button.hidden = !!task.archived;
    button.classList.toggle(
      "current",
      state.page === "tasks" &&
        state.taskId === button.dataset.task &&
        state.screen !== "new",
    );
    button.querySelector("span:nth-child(2)").textContent = task.title;
    button.title = task.title;
    button.setAttribute("aria-label", task.title);
  });
  document.querySelector(".nav-count").textContent = Object.values(
    previewTasks,
  ).filter((task) => !task.archived).length;
}
function chooseTask(id) {
  rememberTask();
  const task = previewTasks[id];
  if (!task || task.archived) return;
  closeSearch();
  Motion.closeDialog($("dialog"));
  state.taskId = id;
  state.title = task.title;
  state.project = task.project;
  state.notes = [...(task.notes || [])];
  state.queue = [...(task.queue || [])];
  $("message").value = task.draft || "";
  switchScreen(task.screen);
  $("conversation-scroll").scrollTop = 0;
}
function startPreviewTask(title) {
  state.taskId = `task-${crypto.randomUUID()}`;
  state.title = title;
  state.notes = [];
  state.queue = [];
  state.attachments = [];
  previewTasks[state.taskId] = {
    title,
    project: state.project,
    screen: "running",
    time: "现在",
  };
  const row = document.createElement("button");
  row.className = "task-link";
  row.dataset.task = state.taskId;
  row.innerHTML = `<span class="task-dot live"></span><span>${escapeHtml(title)}</span><small>现在</small>`;
  (state.project === "WorkPilot"
    ? $("project-tasks")
    : document.querySelector(".sidebar-scroll")
  ).appendChild(row);
}
function highlighted(text, query) {
  const index = String(text)
    .toLocaleLowerCase()
    .indexOf(query.toLocaleLowerCase());
  if (!query || index < 0) return escapeHtml(text);
  return `${escapeHtml(text.slice(0, index))}<mark>${escapeHtml(text.slice(index, index + query.length))}</mark>${escapeHtml(text.slice(index + query.length))}`;
}
function showSearch() {
  closeMenu(false);
  rememberTask();
  const dialog = $("search-dialog");
  dialog.innerHTML = `<form class="search-shell" onsubmit="return false"><div class="search-input-row">${icon("search")}<input id="search-query" type="search" placeholder="搜索任务或项目…" autocomplete="off" aria-label="搜索任务或项目" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="search-results" /><button type="button" class="search-escape" id="search-close" aria-label="关闭搜索">Esc</button></div><div class="search-caption" id="search-caption"></div><div class="search-results" id="search-results" role="listbox" aria-label="搜索结果"></div><footer><span><kbd>↑</kbd><kbd>↓</kbd> 选择 <kbd>Enter</kbd> 打开</span><span>按项目与任务名称查找</span></footer></form>`;
  $("search-query").oninput = () => {
    searchIndex = 0;
    renderSearchResults();
  };
  $("search-close").onclick = closeSearch;
  renderSearchResults();
  Motion.openDialog(dialog);
  $("search-query").focus();
}
function renderSearchResults() {
  const query = $("search-query").value.trim();
  searchMatches = PreviewModel.search(previewTasks, query);
  searchIndex = Math.max(0, Math.min(searchIndex, searchMatches.length - 1));
  $("search-caption").textContent = query
    ? `${searchMatches.length} 个匹配任务`
    : "最近的任务";
  $("search-results").innerHTML = searchMatches.length
    ? searchMatches
        .map(
          ([id, task], index) =>
            `<button type="button" id="search-result-${index}" class="search-result ${index === searchIndex ? "active" : ""}" data-search-task="${id}" role="option" aria-selected="${index === searchIndex}" tabindex="-1"><span class="search-task-icon">${icon("chat")}</span><span class="search-result-copy"><strong>${highlighted(task.title, query)}</strong><small>${highlighted(task.project, query)} <i>·</i> ${task.time || "现在"}</small></span><span class="search-task-state">${["running", "approval"].includes(task.screen) ? '<i class="task-dot live"></i>' : icon("check")}</span>${icon("arrow")}</button>`,
        )
        .join("")
    : `<div class="search-empty">${icon("search")}<strong>没有找到相关任务</strong><span>试试更短的关键词，或搜索项目名称。</span></div>`;
  updateSearchSelection();
}
function updateSearchSelection() {
  const rows = Array.from(
    $("search-results").querySelectorAll(".search-result"),
  );
  rows.forEach((row, index) => {
    row.classList.toggle("active", index === searchIndex);
    row.setAttribute("aria-selected", String(index === searchIndex));
  });
  if (rows[searchIndex]) {
    $("search-query").setAttribute(
      "aria-activedescendant",
      rows[searchIndex].id,
    );
    rows[searchIndex].scrollIntoView({ block: "nearest" });
  } else $("search-query").removeAttribute("aria-activedescendant");
}
function closeSearch() {
  Motion.closeDialog($("search-dialog"));
}
function taskContextMenu(button, point) {
  const id = button.dataset.task;
  rememberTask();
  const task = previewTasks[id];
  if (!task) return;
  const active = ["running", "approval"].includes(task.screen);
  showMenu(
    button,
    task.title,
    [
      { label: "重命名", glyph: "edit", run: () => renameTask(id) },
      {
        label: "归档任务",
        glyph: "folder",
        disabled: active,
        description: active
          ? "任务进行中，请先停止"
          : "从列表移除，保留任务内容",
        run: () => archiveTask(id),
      },
    ],
    point,
  );
}
function renameTask(id) {
  const task = previewTasks[id];
  showDialog(
    "重命名任务",
    `<label>任务名称<input id="rename-value" maxlength="80" value="${escapeHtml(task.title)}" /></label><div class="button-row"><button class="outline-button" data-action="close-dialog">取消</button><button class="solid-button" id="rename-save">保存名称</button></div>`,
  );
  const save = () => {
    if (!PreviewModel.rename(previewTasks, id, $("rename-value").value)) {
      $("rename-value").focus();
      return;
    }
    if (state.taskId === id) {
      state.title = task.title;
      render();
    } else syncTaskList();
    Motion.closeDialog($("dialog"));
    toast("已更新示例任务名称");
  };
  $("rename-save").onclick = save;
  $("rename-value").onkeydown = (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      save();
    }
  };
  $("rename-value").select();
}
function archiveTask(id) {
  const reason = PreviewModel.archive(previewTasks, id);
  if (reason) {
    toast(reason);
    return;
  }
  if (state.taskId === id) {
    state.taskId = null;
    switchScreen("new");
  }
  syncTaskList();
  toast("示例任务已归档");
}
document.addEventListener("contextmenu", (event) => {
  const task = event.target.closest(".task-link[data-task]");
  if (task) {
    event.preventDefault();
    taskContextMenu(task, { x: event.clientX, y: event.clientY });
  }
});
document.addEventListener("keydown", (event) => {
  const task = event.target.closest(".task-link[data-task]");
  if (
    task &&
    ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu")
  ) {
    event.preventDefault();
    taskContextMenu(task);
  }
  if (!$("search-dialog").open || event.isComposing) return;
  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    if (searchMatches.length)
      searchIndex =
        (searchIndex +
          (event.key === "ArrowDown" ? 1 : -1) +
          searchMatches.length) %
        searchMatches.length;
    updateSearchSelection();
  }
  if (event.key === "Enter" && searchMatches[searchIndex]) {
    event.preventDefault();
    chooseTask(searchMatches[searchIndex][0]);
  }
});
document.addEventListener("click", (event) => {
  const result = event.target.closest("[data-search-task]");
  if (result) chooseTask(result.dataset.searchTask);
});
