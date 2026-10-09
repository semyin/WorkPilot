function syncPanelVisibility() {
  const panel = $("work-panel");
  if (!state.panelOpen && panel.contains(document.activeElement))
    $("workspace-open").focus({ preventScroll: true });
  panel.hidden = false;
  panel.inert = !state.panelOpen;
  panel.setAttribute("aria-hidden", String(!state.panelOpen));
  $("shell").classList.toggle("panel-open", state.panelOpen);
  $("workspace-open").setAttribute("aria-expanded", String(state.panelOpen));
}
function setSidebar(open) {
  const mobile = innerWidth <= 620;
  $("shell").classList.toggle("sidebar-collapsed", !open && !mobile);
  $("shell").classList.toggle("sidebar-mobile-open", open && mobile);
  const sidebar = document.querySelector(".sidebar");
  sidebar.inert = !open;
  sidebar.setAttribute("aria-hidden", String(!open));
  $("restore-sidebar").setAttribute("aria-expanded", String(open));
  applyPanelWidth(panelWidth);
  if (!open) $("restore-sidebar").focus({ preventScroll: true });
}
let panelWidth = 348;
let dragState = null;
function intendedSidebarWidth() {
  return $("shell").classList.contains("sidebar-collapsed")
    ? 0
    : parseFloat(
        getComputedStyle($("shell")).getPropertyValue("--sidebar-width"),
      );
}
function applyPanelWidth(value, save = false) {
  const sideWidth = intendedSidebarWidth();
  panelWidth = PreviewModel.panelWidth(value, innerWidth, sideWidth);
  const bounds = PreviewModel.panelBounds(innerWidth, sideWidth);
  $("shell").style.setProperty("--panel-width", `${panelWidth}px`);
  const handle = $("panel-resize");
  handle.setAttribute("aria-valuemin", String(bounds.min));
  handle.setAttribute("aria-valuemax", String(bounds.max));
  handle.setAttribute("aria-valuenow", String(panelWidth));
  handle.setAttribute("aria-valuetext", `工作区宽度 ${panelWidth} 像素`);
  if (save) {
    try {
      localStorage.setItem(
        "workpilot.proposal.panel-width",
        String(panelWidth),
      );
    } catch {}
  }
}
function initWorkspaceControls() {
  try {
    panelWidth =
      Number(localStorage.getItem("workpilot.proposal.panel-width")) || 348;
  } catch {}
  applyPanelWidth(panelWidth);
  const handle = $("panel-resize");
  handle.onpointerdown = (event) => {
    if (event.button !== 0) return;
    closeMenu(false);
    event.preventDefault();
    dragState = {
      pointer: event.pointerId,
      x: event.clientX,
      width: panelWidth,
    };
    handle.setPointerCapture(event.pointerId);
    $("shell").classList.add("is-resizing");
  };
  handle.onpointermove = (event) => {
    if (dragState?.pointer === event.pointerId)
      applyPanelWidth(dragState.width + dragState.x - event.clientX);
  };
  const finish = () => {
    if (!dragState) return;
    if (handle.hasPointerCapture(dragState.pointer))
      handle.releasePointerCapture(dragState.pointer);
    dragState = null;
    $("shell").classList.remove("is-resizing");
    applyPanelWidth(panelWidth, true);
  };
  handle.onpointerup = finish;
  handle.onpointercancel = finish;
  handle.onlostpointercapture = finish;
  handle.ondblclick = () => applyPanelWidth(348, true);
  handle.onkeydown = (event) => {
    const amount = event.shiftKey ? 32 : 16;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const bounds = PreviewModel.panelBounds(innerWidth, intendedSidebarWidth());
    const width =
      event.key === "Home"
        ? bounds.min
        : event.key === "End"
          ? bounds.max
          : panelWidth + (event.key === "ArrowLeft" ? amount : -amount);
    applyPanelWidth(width, true);
  };
  window.addEventListener("resize", () => {
    applyPanelWidth(panelWidth);
    const open =
      innerWidth <= 620
        ? $("shell").classList.contains("sidebar-mobile-open")
        : !$("shell").classList.contains("sidebar-collapsed");
    document.querySelector(".sidebar").inert = !open;
  });
  if (innerWidth <= 620) setSidebar(false);
}
