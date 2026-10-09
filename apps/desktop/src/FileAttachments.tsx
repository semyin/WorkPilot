import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MediaAsset } from "./generated/contracts";
import { media, upload } from "./mediaClient";
import { useWords } from "./workspaceClient";
import "./media.css";
import { Icon } from "./workbench/Icon";
export function FileAttachments({
  assets,
  onChange,
  onBusy,
  compact = false,
  children,
}: {
  assets: MediaAsset[];
  onChange: (assets: MediaAsset[]) => void;
  onBusy: (busy: boolean) => void;
  compact?: boolean;
  children?: (add: ReactNode) => ReactNode;
}) {
  const tr = useWords(),
    [error, setError] = useState(""),
    [progress, setProgress] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const current = useRef(assets),
    controller = useRef<AbortController | null>(null),
    live = useRef(true),
    running = useRef(false),
    handle = useRef<(files: File[], source: "file" | "drop" | "paste") => Promise<void>>(
      async () => {},
    );
  current.current = assets;
  useEffect(() => {
    live.current = true;
    const paste = (e: ClipboardEvent) => {
      if (
        !(e.target instanceof HTMLTextAreaElement) ||
        !e.target.closest(".execution-composer,.execution-create,.wb-composer")
      )
        return;
      const files = Array.from(e.clipboardData?.files || []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length) {
        e.preventDefault();
        void handle.current(files, "paste");
      }
    };
    window.addEventListener("paste", paste);
    return () => {
      live.current = false;
      window.removeEventListener("paste", paste);
    };
  }, []);
  handle.current = async (files, source) => {
    if (running.current) return;
    running.current = true;
    controller.current = new AbortController();
    onBusy(true);
    setError("");
    try {
      if (current.current.length + files.length > 16)
        throw new Error(tr("每条消息最多 16 个附件。", "At most 16 attachments per message."));
      for (const file of files) {
        const asset = await upload(
          file,
          source,
          (p) => {
            if (live.current) setProgress(p);
          },
          controller.current.signal,
        );
        if (live.current) {
          current.current = [...current.current, asset];
          onChange(current.current);
        } else {
          await media(null, { kind: "remove", asset_id: asset.id });
        }
      }
    } catch (e) {
      if (live.current) setError(String(e));
    } finally {
      running.current = false;
      if (live.current) {
        setProgress("");
        onBusy(false);
      }
    }
  };
  return (
    <div
      className={compact ? `wb-composer ${dragging ? "wb-dragging" : ""}` : "file-attachments"}
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes("Files")) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void handle.current(Array.from(e.dataTransfer.files), "drop");
      }}
    >
      <label className={compact ? "wb-attachment-input" : "attachment-input"}>
        {tr("添加文件或图片", "Attach files or images")}
        <input
          ref={input}
          aria-label={tr("添加文件或图片", "Attach files or images")}
          type="file"
          multiple
          accept=".txt,.md,.csv,.docx,.xlsx,.pptx,.pdf,.png,.jpg,.jpeg,.webp,.gif,.json,.html,.svg"
          disabled={!!progress}
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = "";
            void handle.current(files, "file");
          }}
        />
      </label>
      {!compact && (
        <small>
          {tr(
            "可拖入文件，或在输入框粘贴图片。每个文件最多 32 MiB。",
            "Drop files here or paste an image into the composer. Up to 32 MiB per file.",
          )}
        </small>
      )}
      <div className={compact ? "wb-attachment-list" : "attachment-chips"}>
        {assets.map((asset) => (
          <span className={compact ? "wb-attachment-chip" : ""} key={asset.id}>
            {compact && <Icon name="files" />}
            <span title={`${asset.name} · ${Math.ceil(asset.bytes / 1024)} KB`}>{asset.name}</span>
            <button
              aria-label={tr("移除 ", "Remove ") + asset.name}
              onClick={() => {
                void media(null, { kind: "remove", asset_id: asset.id })
                  .then(() => onChange(current.current.filter((a) => a.id !== asset.id)))
                  .catch((e) => setError(String(e)));
              }}
            >
              {compact ? <Icon name="close" /> : "×"}
            </button>
          </span>
        ))}
      </div>
      {progress && (
        <p className="wb-composer-feedback" role="status">
          {progress}{" "}
          <button
            onClick={() =>
              controller.current?.abort(new Error(tr("导入已取消。", "Import cancelled.")))
            }
          >
            {tr("取消导入", "Cancel import")}
          </button>
        </p>
      )}
      {error && (
        <p className="error wb-composer-feedback" role="alert">
          {error}
        </p>
      )}
      {children?.(
        <button
          type="button"
          className="wb-icon-button"
          aria-label={tr("添加附件", "Add attachment")}
          title={tr(
            "添加文件或图片，可拖放或粘贴。每个文件最多 32 MiB。",
            "Attach, drop or paste files. Up to 32 MiB each.",
          )}
          disabled={!!progress}
          onClick={() => input.current?.click()}
        >
          <Icon name="plus" />
        </button>,
      )}
    </div>
  );
}
