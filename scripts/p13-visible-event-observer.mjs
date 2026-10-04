// Observe the normal renderer without injecting hooks into the application.
// Two animation frames and an unoccluded in-viewport text range are required.
// This is a renderer presentation opportunity, not an external display sensor.
export function watchVisibleMarker(marker) {
  window.p13Visible = { marker, domAtMs: null, presentedAtMs: null, frameChecks: 0 };
  let stableFrames = 0;
  const locate = () => {
    for (const element of document.querySelectorAll(
      ".execution-answer:not([hidden]), .conversation-turn.assistant pre",
    )) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const offset = node.textContent.indexOf(marker);
        if (offset < 0) continue;
        window.p13Visible.domAtMs ??= Date.now();
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + marker.length);
        for (const rect of range.getClientRects()) {
          if (!rect.width || !rect.height) continue;
          let left = Math.max(0, rect.left),
            top = Math.max(0, rect.top);
          let right = Math.min(innerWidth, rect.right),
            bottom = Math.min(innerHeight, rect.bottom);
          let parent = element;
          let hidden = false;
          while (parent) {
            const style = getComputedStyle(parent);
            if (
              style.display === "none" ||
              style.visibility !== "visible" ||
              Number(style.opacity) === 0
            )
              hidden = true;
            const box = parent.getBoundingClientRect();
            if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
              left = Math.max(left, box.left);
              right = Math.min(right, box.right);
            }
            if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
              top = Math.max(top, box.top);
              bottom = Math.min(bottom, box.bottom);
            }
            parent = parent.parentElement;
          }
          if (hidden || right - left < rect.width - 1 || bottom - top < rect.height - 1) continue;
          const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
          if (hit && element.contains(hit)) return { left, top, right, bottom };
        }
      }
    }
    return null;
  };
  const frame = () => {
    const box = document.visibilityState === "visible" && locate();
    window.p13Visible.frameChecks++;
    stableFrames = box ? stableFrames + 1 : 0;
    if (stableFrames >= 2) {
      window.p13Visible.presentedAtMs = Date.now();
      window.p13Visible.box = box;
      window.p13Visible.focused = document.hasFocus();
      return;
    }
    window.p13Visible.frame = requestAnimationFrame(frame);
  };
  window.p13Visible.frame = requestAnimationFrame(frame);
}
