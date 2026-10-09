import { useId, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
export function Disclosure({
  title,
  children,
  initial = false,
  className = "",
}: {
  title: ReactNode;
  children: ReactNode;
  initial?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(initial),
    id = useId();
  return (
    <section className={`wb-disclosure ${className} ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="wb-disclosure-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {className.includes("wb-step-summary") && <Icon name="check" />}
        {!className.includes("wb-step-summary") && <Icon name="right" />}
        {title}
        {className.includes("wb-step-summary") && <Icon name="right" />}
      </button>
      <div className="wb-disclosure-body" inert={!open} aria-hidden={!open} id={id}>
        <div>{children}</div>
      </div>
    </section>
  );
}
