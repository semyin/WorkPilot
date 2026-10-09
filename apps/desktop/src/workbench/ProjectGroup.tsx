import { useId, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { Menu } from "./Menu";
import { useWords } from "../workspaceClient";

export function ProjectGroup({
  name,
  count,
  children,
  onSelect,
  onNew,
  onSettings,
}: {
  name: string;
  count: number;
  children: ReactNode;
  onSelect: () => void;
  onNew: () => void;
  onSettings: () => void;
}) {
  const tr = useWords();
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState<{
    anchor: HTMLElement;
    point?: { x: number; y: number };
  } | null>(null);
  const id = useId();
  return (
    <section className={`wb-disclosure ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="wb-project-heading"
        aria-expanded={open}
        aria-controls={id}
        title={tr("右键可新建任务或设置项目", "Right-click to create a task or manage the project")}
        onClick={() => {
          setOpen(!open);
          onSelect();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ anchor: e.currentTarget, point: { x: e.clientX, y: e.clientY } });
        }}
        onKeyDown={(e) => {
          if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
            e.preventDefault();
            setMenu({ anchor: e.currentTarget });
          }
        }}
      >
        <Icon name="down" />
        <Icon name="folder" />
        <span>{name}</span>
        <small>{count}</small>
      </button>
      <div id={id} className="wb-disclosure-body" aria-hidden={!open} inert={!open}>
        <div>
          <div className="wb-project-tasks">{children}</div>
        </div>
      </div>
      {menu && (
        <Menu
          {...menu}
          label={name}
          items={[
            { value: "new", label: tr("新建任务", "New task"), icon: "plus" },
            { value: "settings", label: tr("项目设置", "Project settings"), icon: "settings" },
          ]}
          onPick={(value) => (value === "new" ? onNew() : onSettings())}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}
