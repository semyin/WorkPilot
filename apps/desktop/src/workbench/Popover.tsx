import { useLayoutEffect, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Popover({
  anchor,
  label,
  children,
  onClose,
}: {
  anchor: HTMLElement;
  label: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect(),
      box = ref.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(12, Math.min(a.left, innerWidth - box.width - 12)),
      top: Math.max(12, a.top - box.height - 8),
    });
    ref.current?.focus();
  }, [anchor]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={ref}
      className="wb-popover"
      style={position}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          anchor.focus();
        }
      }}
    >
      {children}
    </div>,
    anchor.closest("dialog") || document.body,
  );
}
