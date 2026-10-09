import { useEffect, useRef, type PointerEvent } from "react";
export function ResizeHandle({
  side,
  width,
  onChange,
  label,
}: {
  side: "left" | "right";
  width: number;
  onChange: (width: number) => void;
  label: string;
}) {
  const min = side === "left" ? 190 : 280,
    max = side === "left" ? 400 : 700;
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  const clamp = (v: number, host?: HTMLElement | null) => {
    const left = host?.querySelector(".wb-sidebar")?.getBoundingClientRect().width || 0;
    const available =
      side === "right"
        ? innerWidth <= 1150
          ? innerWidth - 24
          : innerWidth - left - 420
        : innerWidth - 330;
    return Math.max(Math.min(min, available), Math.min(max, available, Math.round(v)));
  };
  const start = (e: PointerEvent<HTMLDivElement>) => {
    const node = e.currentTarget;
    const host = node.closest<HTMLElement>(".workbench");
    if (!host || e.button !== 0) return;
    e.preventDefault();
    cleanup.current();
    const x = e.clientX;
    const startWidth =
      host
        .querySelector(side === "right" ? ".wb-work-panel" : ".wb-sidebar")
        ?.getBoundingClientRect().width || width;
    node.setPointerCapture(e.pointerId);
    host.classList.add("wb-is-resizing");
    let value = startWidth;
    const move = (event: globalThis.PointerEvent) => {
      value = clamp(startWidth + (event.clientX - x) * (side === "left" ? 1 : -1), host);
      host.style.setProperty(`--${side}`, `${value}px`);
    };
    const detach = () => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", stop);
      node.removeEventListener("pointercancel", stop);
      node.removeEventListener("lostpointercapture", stop);
      host.classList.remove("wb-is-resizing");
      cleanup.current = () => {};
    };
    const stop = () => {
      detach();
      if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
      onChange(value);
    };
    cleanup.current = detach;
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", stop, { once: true });
    node.addEventListener("pointercancel", stop, { once: true });
    node.addEventListener("lostpointercapture", stop, { once: true });
  };
  return (
    <div
      className="wb-panel-resize"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={start}
      onDoubleClick={(e) =>
        onChange(clamp(side === "left" ? 228 : 348, e.currentTarget.closest(".workbench")))
      }
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onChange(
            clamp(
              width + (e.key === "ArrowRight" ? 20 : -20) * (side === "left" ? 1 : -1),
              e.currentTarget.closest(".workbench"),
            ),
          );
        }
      }}
    />
  );
}
