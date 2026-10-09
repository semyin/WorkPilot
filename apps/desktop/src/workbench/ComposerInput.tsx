import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

export function ComposerInput(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    const fit = () => {
      input.style.height = "51px";
      input.style.height = `${Math.min(132, Math.max(51, input.scrollHeight))}px`;
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(input.parentElement!);
    return () => resize.disconnect();
  }, [props.value]);
  return <textarea {...props} ref={ref} rows={2} />;
}
