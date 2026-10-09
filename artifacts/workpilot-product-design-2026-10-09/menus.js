let menuAnchor = null;
let menuGeneration = 0;
const dropdownFields = new Map();
function closeMenu(restore = true, immediate = false) {
  const popup = $("popover");
  const generation = ++menuGeneration;
  if (menuAnchor instanceof HTMLElement) {
    menuAnchor.setAttribute("aria-expanded", "false");
    if (restore && menuAnchor.isConnected)
      menuAnchor.focus({ preventScroll: true });
  }
  menuAnchor = null;
  popup.inert = true;
  const finish = () => {
    if (generation !== menuGeneration) return;
    popup.hidden = true;
    document.body.appendChild(popup);
  };
  popup.getAnimations().forEach((animation) => animation.cancel());
  if (immediate || popup.hidden || !Motion.duration(100)) finish();
  else
    popup
      .animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: Motion.duration(100),
        easing: "ease-out",
      })
      .finished.then(finish)
      .catch(() => {});
}
function placeSurface(anchor, title, html, point, role = "menu") {
  closeMenu(false, true);
  const popup = $("popover");
  const owner = anchor?.closest?.("dialog[open]");
  (owner || document.body).appendChild(popup);
  menuAnchor = anchor;
  if (anchor instanceof HTMLElement)
    anchor.setAttribute("aria-expanded", "true");
  popup.className = "popover";
  popup.setAttribute("role", role);
  popup.setAttribute("aria-label", title);
  popup.innerHTML = `<div class="menu-heading">${escapeHtml(title)}</div>${html}`;
  popup.style.maxHeight = "none";
  popup.inert = false;
  popup.hidden = false;
  const box = point
    ? { left: point.x, top: point.y, bottom: point.y }
    : anchor.getBoundingClientRect();
  const left = Math.max(
    10,
    Math.min(box.left, innerWidth - popup.offsetWidth - 10),
  );
  let top = box.bottom + 7;
  if (top + popup.offsetHeight > innerHeight - 10)
    top = Math.max(10, box.top - popup.offsetHeight - 7);
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
  popup.style.maxHeight = `${Math.max(100, innerHeight - top - 12)}px`;
  Motion.enter(popup, top < box.top ? 4 : -4);
  return popup;
}
function showMenu(anchor, title, options, point) {
  const popup = placeSurface(anchor, title, "", point);
  options.forEach(
    ({
      label,
      description,
      glyph = "check",
      checked,
      disabled,
      danger,
      shortcut,
      run,
    }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `menu-row${checked ? " chosen" : ""}${danger ? " danger" : ""}`;
      button.disabled = !!disabled;
      button.setAttribute(
        "role",
        checked === undefined ? "menuitem" : "menuitemradio",
      );
      if (checked !== undefined)
        button.setAttribute("aria-checked", String(checked));
      button.innerHTML = `${icon(glyph)}<span class="menu-copy"><strong>${escapeHtml(label)}</strong>${description ? `<small>${escapeHtml(description)}</small>` : ""}</span>${shortcut ? `<kbd>${escapeHtml(shortcut)}</kbd>` : ""}${checked ? `<span class="menu-check">${icon("check")}</span>` : ""}`;
      button.onclick = (event) => {
        event.stopPropagation();
        closeMenu(false);
        run();
        const next = anchor?.id ? document.getElementById(anchor.id) : anchor;
        const dialog = document.querySelector("dialog[open]");
        if (next?.isConnected && (!dialog || dialog.contains(next)))
          next.focus({ preventScroll: true });
      };
      popup.appendChild(button);
    },
  );
  // Size after the options exist, including when a dialog owns this surface.
  popup.style.maxHeight = "none";
  const box = point
    ? { left: point.x, top: point.y, bottom: point.y }
    : anchor.getBoundingClientRect();
  popup.style.left = `${Math.max(10, Math.min(box.left, innerWidth - popup.offsetWidth - 10))}px`;
  const top =
    box.bottom + popup.offsetHeight + 17 <= innerHeight
      ? box.bottom + 7
      : Math.max(10, box.top - popup.offsetHeight - 7);
  popup.style.top = `${top}px`;
  popup.style.maxHeight = `${Math.max(100, innerHeight - top - 12)}px`;
  (
    popup.querySelector(".chosen:not(:disabled)") ||
    popup.querySelector("button:not(:disabled)")
  )?.focus({ preventScroll: true });
}
function dropdown(id, label, value, options, onChange, compact = false) {
  dropdownFields.set(id, { label, value, options, onChange });
  const selected = options.find((option) => option.value === value);
  return `<button type="button" id="${id}" class="select-trigger${compact ? " compact-select" : ""}" data-dropdown="${id}" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(label)}"><span>${escapeHtml(selected?.label || value)}</span>${icon("chevron-down")}</button>`;
}
function showDialog(title, content, className = "") {
  closeMenu(false);
  const dialog = $("dialog");
  dialog.className = className;
  dialog.setAttribute("aria-label", title);
  $("dialog-body").innerHTML =
    `<div class="dialog-header"><h2>${title}</h2><button class="icon-button" data-action="close-dialog" aria-label="关闭对话框">${icon("close")}</button></div><div class="dialog-content">${content}</div>`;
  Motion.openDialog(dialog);
}
document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-dropdown]");
  if (!trigger) return;
  const field = dropdownFields.get(trigger.dataset.dropdown);
  if (!field) return;
  event.stopImmediatePropagation();
  if (menuAnchor === trigger && !$("popover").hidden) {
    closeMenu();
    return;
  }
  showMenu(
    trigger,
    field.label,
    field.options.map((option) => ({
      label: option.label,
      description: option.description,
      glyph: option.glyph || "check",
      checked: option.value === field.value,
      run: () => field.onChange(option.value),
    })),
  );
});
document.addEventListener("keydown", (event) => {
  const popup = $("popover");
  if (popup.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeMenu();
    return;
  }
  if (event.key === "Tab") {
    closeMenu(false);
    return;
  }
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = Array.from(popup.querySelectorAll("button:not(:disabled)"));
  if (!buttons.length) return;
  const index = buttons.indexOf(document.activeElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) %
          buttons.length;
  buttons[next].focus();
});
window.addEventListener("resize", () => closeMenu(false));
document.addEventListener(
  "scroll",
  (event) => {
    if (!$("popover").hidden && !$("popover").contains(event.target))
      closeMenu(false);
  },
  true,
);
