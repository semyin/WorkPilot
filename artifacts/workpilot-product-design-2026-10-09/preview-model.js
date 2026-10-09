// Pure proposal rules. They do not read files, contact a model or change the app.
const PreviewModel = {
  tasks: {
    design: {
      title: "重做产品工作台",
      project: "WorkPilot",
      screen: "running",
      time: "现在",
    },
    files: {
      title: "整理项目资料",
      project: "WorkPilot",
      screen: "completed",
      time: "昨天",
    },
    code: {
      title: "检查代码与文档",
      project: "WorkPilot",
      screen: "completed",
      time: "周一",
    },
    research: {
      title: "整理阅读笔记",
      project: "独立任务",
      screen: "completed",
      time: "周一",
    },
  },
  rename(tasks, id, value) {
    const title = Array.from(String(value).trim().replace(/\s+/g, " "))
      .slice(0, 80)
      .join("");
    if (!tasks[id] || !title) return false;
    tasks[id].title = title;
    return true;
  },
  archive(tasks, id) {
    const task = tasks[id];
    if (!task) return "任务不存在";
    if (["running", "approval"].includes(task.screen))
      return "请先停止任务，再归档";
    task.archived = true;
    return null;
  },
  search(tasks, text) {
    const query = String(text).trim().toLocaleLowerCase();
    return Object.entries(tasks).filter(
      ([, task]) =>
        !task.archived &&
        `${task.title} ${task.project}`.toLocaleLowerCase().includes(query),
    );
  },
  panelBounds(viewport, sidebar = 0) {
    const min = Math.min(280, Math.max(160, viewport - 24));
    const available =
      viewport > 1150 ? viewport - sidebar - 420 : viewport - 24;
    return { min, max: Math.max(min, Math.min(680, available)) };
  },
  panelWidth(value, viewport, sidebar = 0) {
    const { min, max } = this.panelBounds(viewport, sidebar);
    const width = Number.isFinite(Number(value)) ? Number(value) : 348;
    return Math.round(Math.max(min, Math.min(max, width)));
  },
  context(used, limit) {
    if (
      !Number.isFinite(used) ||
      !Number.isFinite(limit) ||
      used < 0 ||
      limit <= 0
    )
      return null;
    return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
  },
};
