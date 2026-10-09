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
  busy = false,
}: {
  name: string;
  count: number;
  children: ReactNode;
  onSelect: () => void;
  onNew: () => void;
  onSettings: () => void;
  busy?: boolean;
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
      <div className="wb-project-row">
        <button
          type="button"
          className="wb-project-heading"
          aria-expanded={open}
          aria-controls={id}
          title={name}
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
        <button
          type="button"
          className="wb-icon-button wb-project-new"
          aria-label={tr(`在 ${name} 中新建任务`, `New task in ${name}`)}
          title={tr("新建任务", "New task")}
          disabled={busy}
          onClick={() => {
            setOpen(true);
            onNew();
          }}
        >
          <Icon name="edit" />
        </button>
      </div>
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
            { value: "new", label: tr("新建任务", "New task"), icon: "edit", disabled: busy },
            { value: "settings", label: tr("项目设置", "Project settings"), icon: "settings" },
          ]}
          onPick={(value) => (value === "new" ? onNew() : onSettings())}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}
