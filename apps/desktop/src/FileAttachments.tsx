import { useEffect, useRef, useState } from "react";
import type { MediaAsset } from "./generated/contracts";
import { media, upload } from "./mediaClient";
import { useWords } from "./workspaceClient";
import "./media.css";
export function FileAttachments({
  assets,
  onChange,
  onBusy,
}: {
  assets: MediaAsset[];
  onChange: (assets: MediaAsset[]) => void;
  onBusy: (busy: boolean) => void;
}) {
  const tr = useWords(),
    [error, setError] = useState(""),
    [progress, setProgress] = useState("");
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
        !e.target.closest(".execution-composer,.execution-create")
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
      className="file-attachments"
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        void handle.current(Array.from(e.dataTransfer.files), "drop");
      }}
    >
      <label className="attachment-input">
        {tr("添加文件或图片", "Attach files or images")}
        <input
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
      <small>
        {tr(
          "可拖入文件，或在输入框粘贴图片。每个文件最多 32 MiB。",
          "Drop files here or paste an image into the composer. Up to 32 MiB per file.",
        )}
      </small>
      <div className="attachment-chips">
        {assets.map((asset) => (
          <span key={asset.id}>
            <strong>{asset.name}</strong> · {Math.ceil(asset.bytes / 1024)} KB{" "}
            <button
              aria-label={tr("移除 ", "Remove ") + asset.name}
              onClick={() => {
                void media(null, { kind: "remove", asset_id: asset.id })
                  .then(() => onChange(current.current.filter((a) => a.id !== asset.id)))
                  .catch((e) => setError(String(e)));
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {progress && (
        <p role="status">
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
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
