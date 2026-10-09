/** Restore keyboard position without turning a mouse-opened control into a focus ring. */
export function captureFocusReturn(target: HTMLElement | null, pointer = false) {
  const keyboard =
    !pointer && target?.matches(":focus-visible") && !target.hasAttribute("data-pointer-focus");
  return () => {
    if (!target?.isConnected) return;
    if (!keyboard) {
      target.setAttribute("data-pointer-focus", "");
      const clear = () => {
        target.removeAttribute("data-pointer-focus");
        target.removeEventListener("blur", clear);
        target.removeEventListener("keydown", key);
      };
      const key = (event: KeyboardEvent) => {
        if (!["Escape", "Shift", "Control", "Alt", "Meta"].includes(event.key)) clear();
      };
      target.addEventListener("blur", clear, { once: true });
      target.addEventListener("keydown", key);
    }
    target.focus({ preventScroll: true });
  };
}
