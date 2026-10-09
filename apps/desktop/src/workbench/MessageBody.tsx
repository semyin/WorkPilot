import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import appIcon from "../../../../assets/icons/png/128.png";

export function MessageBody({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Model output is content, never executable HTML or an automatic remote image request.
        img: ({ alt }) => <span>{alt || "Image"}</span>,
        a: ({ href, children }) =>
          /^https?:\/\//i.test(href || "") ? (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ) : (
            <span>{children}</span>
          ),
      }}
    >
      {text}
    </Markdown>
  );
}

export function AssistantMessage({
  text,
  at,
  english,
  children,
}: {
  text: string;
  at?: number;
  english: boolean;
  children?: ReactNode;
}) {
  const time = at
    ? Date.now() - at < 60_000
      ? english
        ? "Just now"
        : "刚刚"
      : new Intl.DateTimeFormat(english ? "en" : "zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        }).format(at)
    : null;
  return (
    <>
      <div className="wb-assistant-header">
        <img src={appIcon} alt="" />
        WorkPilot
        {time && <time dateTime={new Date(at!).toISOString()}>{time}</time>}
      </div>
      <article className="wb-assistant-message">
        <MessageBody text={text} />
        {children}
      </article>
    </>
  );
}
