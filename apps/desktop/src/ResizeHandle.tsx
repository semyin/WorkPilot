import type { PointerEvent } from "react";
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
  const clamp = (v: number) => Math.max(min, Math.min(max, Math.round(v)));
  const start = (e: PointerEvent<HTMLDivElement>) => {
    const node = e.currentTarget;
    const host = node.closest<HTMLElement>(".workspace-root");
    if (!host) return;
    const x = e.clientX;
    node.setPointerCapture(e.pointerId);
    let value = width;
    const move = (event: globalThis.PointerEvent) => {
      value = clamp(width + (event.clientX - x) * (side === "left" ? 1 : -1));
      host.style.setProperty(`--${side}`, `${value}px`);
    };
    const stop = () => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", stop);
      node.removeEventListener("pointercancel", stop);
      onChange(value);
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", stop, { once: true });
    node.addEventListener("pointercancel", stop, { once: true });
  };
  return (
    <div
      className={`workspace-resize ${side}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onChange(clamp(width + (e.key === "ArrowRight" ? 20 : -20) * (side === "left" ? 1 : -1)));
        }
      }}
    />
  );
}
