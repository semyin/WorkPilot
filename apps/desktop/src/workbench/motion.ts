import { useEffect } from "react";

export function motionDuration(ms: number) {
  return document.documentElement.dataset.motion === "off" ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 0
    : ms;
}

// Native details retain their real open state and onToggle callbacks. The animation
// only interpolates height, including fast reversals, using the proposal timings.
export function useWorkbenchMotion() {
  useEffect(() => {
    const active = new Map<HTMLDetailsElement, Animation>();
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || !(e.target instanceof Element)) return;
      const summary = e.target.closest("summary");
      const details = summary?.parentElement;
      if (!(details instanceof HTMLDetailsElement) || !details.closest(".workbench,.wb-dialog"))
        return;
      e.preventDefault();
      const open = details.dataset.expanded ? details.dataset.expanded !== "true" : !details.open;
      const from = details.getBoundingClientRect().height;
      active.get(details)?.cancel();
      active.delete(details);
      details.dataset.expanded = String(open);
      details.open = open;
      const to = details.getBoundingClientRect().height;
      if (!motionDuration(210)) {
        details.style.overflow = "";
        return;
      }
      details.open = true;
      details.style.overflow = "hidden";
      const animation = details.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: 210,
        easing: "cubic-bezier(.2,.75,.25,1)",
      });
      active.set(details, animation);
      void animation.finished
        .then(() => {
          if (active.get(details) !== animation) return;
          active.delete(details);
          details.open = open;
          details.style.overflow = "";
        })
        .catch(() => {});
    };
    document.addEventListener("click", click);
    return () => {
      document.removeEventListener("click", click);
      active.forEach((animation, node) => {
        animation.cancel();
        node.style.overflow = "";
      });
    };
  }, []);
}
