import { motionDuration } from "./motion";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";
import { captureFocusReturn } from "./focus";

export type MenuItem = {
  value: string;
  label: string;
  description?: string;
  icon?: IconName;
  disabled?: boolean;
  danger?: boolean;
};
export function Menu({
  anchor,
  point,
  label,
  items,
  selected,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  point?: { x: number; y: number };
  label: string;
  items: MenuItem[];
  selected?: string;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [leaving, setLeaving] = useState(false);
  const [restoreFocus] = useState(() => captureFocusReturn(anchor, !!point));
  const close = (focus = true, pick?: string) => {
    if (timer.current) return;
    setLeaving(true);
    // Apply the choice before another control (for example Save) can read it.
    // The animation only delays removal of the menu, never the user's action.
    if (focus) restoreFocus();
    if (pick !== undefined) onPick(pick);
    timer.current = setTimeout(() => {
      onClose();
    }, motionDuration(100));
  };
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const box = node.current!.getBoundingClientRect();
    const x = point?.x ?? rect.left,
      y = point?.y ?? rect.bottom;
    setPosition({
      left: Math.max(10, Math.min(x, innerWidth - box.width - 10)),
      top: Math.max(10, Math.min(y + 7, innerHeight - box.height - 10)),
    });
    (
      node.current!.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled)') ||
      node.current!.querySelector<HTMLButtonElement>("button:not(:disabled)")
    )?.focus();
  }, [anchor, point]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!node.current?.contains(event.target as Node) && !anchor.contains(event.target as Node))
        close(false);
    };
    const resize = () => close(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", resize);
      clearTimeout(timer.current);
    };
  }, []);
  const isSelect = selected !== undefined;
  return createPortal(
    <div
      ref={node}
      style={position}
      className={`wb-popover ${leaving ? "wb-leaving" : ""}`}
      role={isSelect ? "listbox" : "menu"}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === "Tab") close(false);
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(
          node.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        );
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}
    >
      <div className="wb-menu-heading">{label}</div>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          className={`wb-menu-row ${selected === item.value ? "wb-chosen" : ""} ${item.danger ? "wb-danger" : ""}`}
          role={isSelect ? "option" : "menuitem"}
          aria-selected={isSelect ? selected === item.value : undefined}
          disabled={item.disabled || leaving}
          onClick={() => close(true, item.value)}
        >
          {item.icon && <Icon name={item.icon} />}
          <span className="wb-menu-copy">
            <strong>{item.label}</strong>
            {item.description && <small>{item.description}</small>}
          </span>
          {selected === item.value && (
            <span className="wb-menu-check">
              <Icon name="check" />
            </span>
          )}
        </button>
      ))}
    </div>,
    anchor.closest("dialog") || document.body,
  );
}
export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
  icon,
  display,
  compact = false,
}: {
  label: string;
  value: string;
  options: MenuItem[];
  onChange: (value: string) => void;
  disabled?: boolean;
  icon?: IconName;
  display?: string;
  compact?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <>
      <button
        type="button"
        className={`wb-select-trigger ${compact ? "wb-option" : ""}`}
        ref={ref}
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon && <Icon name={icon} />}
        <span>{display || options.find((option) => option.value === value)?.label || label}</span>
        <Icon name="down" />
      </button>
      {open && ref.current && (
        <Menu
          anchor={ref.current}
          label={label}
          items={options}
          selected={value}
          onPick={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
