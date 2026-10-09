import { motionDuration } from "./motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { useWords } from "../workspaceClient";
import { captureFocusReturn } from "./focus";
export function Dialog({
  title,
  children,
  onClose,
  className = "",
  busy = false,
  customLayout = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  busy?: boolean;
  customLayout?: boolean;
}) {
  const tr = useWords(),
    ref = useRef<HTMLDialogElement>(null);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const restoreFocus = captureFocusReturn(document.activeElement as HTMLElement | null);
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      clearTimeout(timer.current);
      // Release native modal focus trapping before restoring the opener. This also
      // makes React's development setup/cleanup cycle return to the same control.
      dialog?.close();
      restoreFocus();
    };
  }, []);
  const close = () => {
    if (busy || leaving) return;
    setLeaving(true);
    timer.current = setTimeout(onClose, motionDuration(130));
  };
  return createPortal(
    <dialog
      ref={ref}
      className={`wb-dialog ${className} ${leaving ? "wb-leaving" : ""}`}
      aria-label={title}
      onKeyDown={(e) => {
        // Search inputs consume Escape to clear their text before the native
        // dialog cancel event. Keep the proposal's single-Escape close behavior.
        if (e.key === "Escape" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            close();
        }
      }}
    >
      <div className="wb-dialog-body">
        {!customLayout && (
          <div className="wb-dialog-header">
            <h2>{title}</h2>
            <button
              type="button"
              className="wb-icon-button"
              aria-label={tr("关闭", "Close")}
              disabled={busy}
              onClick={close}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        {customLayout ? children : <div className="wb-dialog-content">{children}</div>}
      </div>
    </dialog>,
    document.body,
  );
}
