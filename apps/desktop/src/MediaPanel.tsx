import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  MediaAsset,
  DocumentUnit,
  ImageService,
  FileVersion,
  WorkbenchOperation,
} from "./generated/contracts";
import { media, mediaWork } from "./mediaClient";
import { useWords } from "./workspaceClient";
import { Saved } from "./SavedContent";
import { executionCommand } from "./executionClient";
import "./media.css";
import { MediaTransferPanel } from "./MediaTransferPanel";
type Page = { asset: MediaAsset; units: DocumentUnit[]; next: number | null; total: number };
const isOffice = (asset: MediaAsset) =>
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ].includes(asset.media_type);
const newService = (): ImageService => ({
  id: crypto.randomUUID(),
  label: "",
  base_url: "https://api.openai.com/v1",
  model: "",
  revision: 0,
  credential: null,
  supports_edit: true,
  sizes: ["auto", "1024x1024", "1536x1024", "1024x1536"],
  qualities: ["auto", "low", "medium", "high"],
  formats: ["png", "jpeg", "webp"],
  max_count: 1,
  request_base64: false,
  auth_required: true,
});
export function MediaPanel({
  task,
  onClose,
  onAttach,
}: {
  task: string | null;
  onClose: () => void;
  onAttach: (asset: MediaAsset) => void;
}) {
  const tr = useWords(),
    [tab, setTab] = useState("files"),
    [assets, setAssets] = useState<MediaAsset[]>([]),
    [services, setServices] = useState<ImageService[]>([]),
    [operations, setOperations] = useState<WorkbenchOperation[]>([]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState<Page | null>(null),
    [preview, setPreview] = useState(""),
    [previewPage, setPreviewPage] = useState(1),
    [previewPages, setPreviewPages] = useState(1),
    [rendering, setRendering] = useState(false),
    [importPath, setImportPath] = useState("");
  const [service, setService] = useState<ImageService>(newService),
    [secret, setSecret] = useState(""),
    [selected, setSelected] = useState(""),
    [prompt, setPrompt] = useState(""),
    [size, setSize] = useState("auto"),
    [quality, setQuality] = useState("auto"),
    [format, setFormat] = useState("png"),
    [count, setCount] = useState(1),
    [outputName, setOutputName] = useState(""),
    [references, setReferences] = useState<string[]>([]);
  const live = useRef(true),
    working = useRef(false),
    previewAsset = useRef<string | null>(null);
  const refresh = async () => {
    const result = await media<{ services: ImageService[] }>(null, { kind: "image_services" });
    if (!live.current) return;
    setServices(result.services);
    if (task) {
      const [a, o] = await Promise.all([
        media<{ assets: MediaAsset[] }>(task, { kind: "list" }),
        mediaWork<{ items: { operation: WorkbenchOperation }[] }>(task, { kind: "operations" }),
      ]);
      if (live.current) {
        setAssets(a.assets);
        setOperations(o.items.map((i) => i.operation).filter((v) => v.kind === "media"));
      }
    }
  };
  useEffect(() => {
    live.current = true;
    let refreshing = false;
    const tick = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        await refresh();
      } catch (e) {
        if (live.current) setError(String(e));
      } finally {
        refreshing = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1200);
    return () => {
      live.current = false;
      clearInterval(timer);
      if (previewAsset.current)
        void media(task, { kind: "cancel_preview", asset_id: previewAsset.current }).catch(
          () => {},
        );
    };
  }, [task]);
  const act = async (fn: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      if (live.current) await refresh();
    } catch (e) {
      if (live.current) setError(String(e));
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  };
  const read = async (asset: MediaAsset, start = 0) => {
    const result = await media<Page>(task, { kind: "read", asset_id: asset.id, start, limit: 16 });
    if (live.current) {
      setPage(result);
      setPreview("");
      setPreviewPage(1);
      setPreviewPages(1);
    }
  };
  const render = async (asset: MediaAsset, number: number) => {
    previewAsset.current = asset.id;
    setRendering(true);
    try {
      const result = await media<{ image: string; pages: number }>(task, {
        kind: "preview",
        asset_id: asset.id,
        page: number,
      });
      if (live.current) {
        setPreview(result.image);
        setPreviewPage(number);
        setPreviewPages(result.pages || 1);
      }
    } finally {
      previewAsset.current = null;
      if (live.current) setRendering(false);
    }
  };
  const selectedService = services.find((s) => s.id === selected);
  const chooseService = (id: string) => {
    setSelected(id);
    const s = services.find((s) => s.id === id);
    if (s) {
      setSize(s.sizes[0]);
      setQuality(s.qualities[0] || "");
      setFormat(s.formats[0]);
      setCount(1);
    }
  };
  const generate = async () => {
    if (!task)
      throw new Error(
        tr(
          "请先选择一个绑定文件夹的执行任务。",
          "Select an execution task with a project folder first.",
        ),
      );
    if (!selectedService)
      throw new Error(
        tr("请先配置并选择图片服务。", "Configure and select an image service first."),
      );
    const name = outputName.trim() || `image-${Date.now()}`;
    const paths = Array.from(
      { length: count },
      (_, i) => `${name}${count > 1 ? `-${i + 1}` : ""}.${format}`,
    );
    const expected: FileVersion[] = [];
    for (const path of paths) {
      const file = await mediaWork<{ version: FileVersion }>(task, { kind: "read_file", path });
      expected.push(file.version);
    }
    await mediaWork(task, {
      kind: "media",
      effect: {
        kind: "generate_image",
        request: {
          service_id: selectedService.id,
          service_revision: selectedService.revision,
          prompt,
          size,
          quality: quality || null,
          format,
          count,
          references,
          paths,
          expected,
        },
      },
    });
    setNotice(
      tr(
        "图片请求已登记，请查看下方进度或审批。",
        "Image request recorded. See progress or approval below.",
      ),
    );
  };
  const importFile = async (path: string) => {
    if (!task) throw new Error(tr("请先选择任务。", "Select a task first."));
    const file = await mediaWork<{ version: FileVersion }>(task, { kind: "read_file", path });
    const result = await mediaWork<{ asset: MediaAsset }>(task, {
      kind: "read_document",
      path,
      expected: file.version,
    });
    await read(result.asset);
    setNotice(
      tr(
        "已读取当前文件，并保存为新的内容快照。旧记录仍然保留。",
        "Read the current file into a new snapshot. Previous records are preserved.",
      ),
    );
  };
  return (
    <section
      className="media-panel"
      role="dialog"
      aria-label={tr("文件成果与图片", "Files and images")}
    >
      <header>
        <h2>{tr("文件成果与图片", "Files and images")}</h2>
        <button onClick={onClose}>{tr("关闭", "Close")}</button>
      </header>
      <nav>
        {[
          ["files", tr("附件与成果", "Attachments & outputs")],
          ["transfer", tr("附件迁移", "Attachment transfer")],
          ["images", tr("生成图片", "Generate images")],
          ["settings", tr("图片服务设置", "Image service settings")],
        ].map(([key, label]) => (
          <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="media-body">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {busy && <p role="status">{tr("正在处理…", "Working…")}</p>}
        {tab === "transfer" &&
          (task ? (
            <MediaTransferPanel task={task} assets={assets} onImported={refresh} />
          ) : (
            <p>{tr("请先选择一个任务。", "Select a task first.")}</p>
          ))}
        {tab === "files" && (
          <>
            {!task ? (
              <p>
                {tr(
                  "选中任务后，可以查看它的附件和成果。",
                  "Select a task to see its attachments and outputs.",
                )}
              </p>
            ) : (
              <>
                <div className="media-actions">
                  <label>
                    {tr("读取项目文件", "Read a project file")}
                    <input
                      placeholder={tr("例如：报告.docx", "For example: report.docx")}
                      value={importPath}
                      onChange={(e) => setImportPath(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={busy || !importPath.trim()}
                    onClick={() => void act(() => importFile(importPath))}
                  >
                    {tr("读取文件", "Read file")}
                  </button>
                </div>
                <div className="media-grid">
                  <div className="media-list">
                    {assets.map((asset) => (
                      <article className="media-card" key={asset.id} data-media-asset={asset.id}>
                        <button onClick={() => void act(() => read(asset))}>
                          <strong>{asset.name}</strong>
                        </button>
                        <small>
                          {Math.ceil(asset.bytes / 1024)} KB ·{" "}
                          {asset.image
                            ? `${asset.image.width} × ${asset.image.height}`
                            : `${asset.units} ${tr("段/页/行", "units")}`}
                        </small>
                        <small>
                          {new Date(asset.at_ms).toLocaleString()} ·{" "}
                          {asset.operation_id
                            ? tr("生成成果", "Generated output")
                            : tr("输入资料", "Input file")}
                        </small>
                        {asset.path && <small>{asset.path}</small>}
                        {asset.origin && (
                          <small>
                            {tr("迁入来源：", "Imported from: ")}
                            {asset.origin.name} · {new Date(asset.origin.at_ms).toLocaleString()}
                          </small>
                        )}
                        <button
                          disabled={busy}
                          onClick={() => void act(async () => onAttach(asset))}
                        >
                          {tr("加入下一条消息", "Add to next message")}
                        </button>
                        <small>
                          {tr("内容版本：", "Content version: ")}
                          {asset.sha256.slice(0, 12)}
                        </small>
                      </article>
                    ))}
                    {!assets.length && (
                      <p>
                        {tr(
                          "暂时没有文件。可在对话输入框添加附件，或读取项目文件。",
                          "No files yet. Attach files in the composer or read a project file.",
                        )}
                      </p>
                    )}
                  </div>
                  <div className="media-detail">
                    {page && (
                      <>
                        <h3>{page.asset.name}</h3>
                        <p>
                          {tr(
                            "这里显示保存时的文件内容。外部修改后，请点击“读取最新版本”。",
                            "This is a saved snapshot. After external edits, choose Read latest version.",
                          )}
                        </p>
                        <div className="media-actions">
                          {(page.asset.image ||
                            page.asset.media_type === "application/pdf" ||
                            isOffice(page.asset)) && (
                            <button
                              disabled={busy}
                              onClick={() => void act(() => render(page.asset, 1))}
                            >
                              {isOffice(page.asset)
                                ? tr("查看原版式预览", "View layout preview")
                                : tr("查看图像预览", "View image preview")}
                            </button>
                          )}
                          {page.asset.path && (
                            <>
                              <button
                                disabled={busy}
                                onClick={() => void act(() => importFile(page.asset.path!))}
                              >
                                {tr("读取最新版本", "Read latest version")}
                              </button>
                              <button
                                onClick={() =>
                                  void act(async () => {
                                    await invoke("project_open_external", {
                                      taskId: task,
                                      path: page.asset.path,
                                      folder: false,
                                    });
                                  })
                                }
                              >
                                {tr("用外部软件打开", "Open in another app")}
                              </button>
                              <button
                                onClick={() =>
                                  void act(async () => {
                                    await invoke("project_open_external", {
                                      taskId: task,
                                      path: page.asset.path,
                                      folder: true,
                                    });
                                  })
                                }
                              >
                                {tr("打开所在文件夹", "Open containing folder")}
                              </button>
                            </>
                          )}
                          {page.asset.image && (
                            <button
                              onClick={() => {
                                setReferences([page.asset.id]);
                                setTab("images");
                                setPrompt("");
                                setNotice(
                                  tr(
                                    "已选为参考图。填写修改要求，再选择图片服务。",
                                    "Selected as a reference. Describe your edit and choose an image service.",
                                  ),
                                );
                              }}
                            >
                              {tr("继续修改这张图", "Edit this image")}
                            </button>
                          )}
                          <button
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                await media(task, { kind: "remove", asset_id: page.asset.id });
                                setPage(null);
                                setPreview("");
                              })
                            }
                          >
                            {tr("移除记录（保留原文件）", "Remove record (keep original)")}
                          </button>
                        </div>
                        {rendering && (
                          <p className="execution-notice">
                            {tr("正在准备预览…", "Preparing preview…")}
                            <button
                              onClick={() =>
                                void media(task, {
                                  kind: "cancel_preview",
                                  asset_id: page.asset.id,
                                })
                                  .then(() => {
                                    if (live.current)
                                      setNotice(tr("正在停止预览…", "Stopping preview…"));
                                  })
                                  .catch((e) => {
                                    if (live.current) setError(String(e));
                                  })
                              }
                            >
                              {tr("停止预览", "Stop preview")}
                            </button>
                          </p>
                        )}
                        {page.asset.warnings.map((warning, i) => (
                          <p key={i} className="execution-notice">
                            {warning}
                          </p>
                        ))}
                        {preview && (
                          <>
                            {isOffice(page.asset) && (
                              <p className="execution-notice">
                                {tr(
                                  "由原文件转换为页面预览。字体替代可能影响排版；原文件保持不变。",
                                  "Page preview converted from the original file. Font substitutions may affect layout; the original stays unchanged.",
                                )}
                              </p>
                            )}
                            <img className="media-preview" src={preview} alt={page.asset.name} />
                            {(page.asset.media_type === "application/pdf" ||
                              isOffice(page.asset)) && (
                              <div className="media-actions">
                                <button
                                  disabled={busy || previewPage <= 1}
                                  onClick={() =>
                                    void act(() => render(page.asset, previewPage - 1))
                                  }
                                >
                                  {tr("上一页", "Previous page")}
                                </button>
                                <span aria-label={tr("预览页码", "Preview page")}>
                                  {previewPage} / {previewPages}
                                </span>
                                <button
                                  disabled={busy || previewPage >= previewPages}
                                  onClick={() =>
                                    void act(() => render(page.asset, previewPage + 1))
                                  }
                                >
                                  {tr("下一页", "Next page")}
                                </button>
                              </div>
                            )}
                          </>
                        )}
                        {page.units.map((unit, i) => (
                          <article className="media-unit" key={i}>
                            <small>{unit.locator}</small>
                            <pre>
                              {unit.text ||
                                tr("（此段没有可提取文字）", "(No extractable text in this unit)")}
                            </pre>
                          </article>
                        ))}
                        <div className="media-actions">
                          <button
                            disabled={busy}
                            onClick={() => void act(() => read(page.asset, 0))}
                          >
                            {tr("回到开头", "Back to start")}
                          </button>
                          {page.next !== null && (
                            <button
                              disabled={busy}
                              onClick={() => void act(() => read(page.asset, page.next!))}
                            >
                              {tr("读取后续内容", "Read more")}
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        )}
        {tab === "images" && (
          <div className="media-form">
            <p>
              {tr(
                "图片服务独立计费。没有服务返回的准确价格时，费用显示为未知。",
                "Image services bill separately. Cost remains unknown unless an exact provider price is available.",
              )}
            </p>
            {!services.length && (
              <p className="execution-notice">
                {tr(
                  "尚未配置图片服务。请先打开“图片服务设置”。",
                  "No image service configured. Open Image service settings first.",
                )}
              </p>
            )}
            <label>
              {tr("图片服务", "Image service")}
              <select
                aria-label={tr("图片服务", "Image service")}
                value={selected}
                onChange={(e) => chooseService(e.target.value)}
              >
                <option value="">{tr("请选择", "Choose a service")}</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label} · {s.model}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr("图片要求或修改要求", "Image prompt or edit instructions")}
              <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </label>
            <div className="media-form-row">
              <label>
                {tr("尺寸", "Size")}
                <select
                  aria-label={tr("尺寸", "Size")}
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                >
                  {(selectedService?.sizes || ["auto"]).map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                {tr("质量", "Quality")}
                <select
                  aria-label={tr("质量", "Quality")}
                  value={quality}
                  onChange={(e) => setQuality(e.target.value)}
                >
                  {(selectedService?.qualities.length ? selectedService.qualities : [""]).map(
                    (v) => (
                      <option key={v} value={v}>
                        {v || tr("不发送此选项", "Omit this option")}
                      </option>
                    ),
                  )}
                </select>
              </label>
            </div>
            <div className="media-form-row">
              <label>
                {tr("格式", "Format")}
                <select
                  aria-label={tr("格式", "Format")}
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                >
                  {(selectedService?.formats || ["png"]).map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                {tr("数量", "Count")}
                <input
                  type="number"
                  min={1}
                  max={selectedService?.max_count || 1}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                />
              </label>
            </div>
            <label>
              {tr(
                "保存名称（项目内，不含扩展名）",
                "Output name (inside the project, without extension)",
              )}
              <input
                value={outputName}
                placeholder="image-01"
                onChange={(e) => setOutputName(e.target.value)}
              />
            </label>
            <fieldset>
              <legend>{tr("参考图（最多 4 张）", "Reference images (up to 4)")}</legend>
              {assets
                .filter((a) => a.image && a.media_type !== "image/gif")
                .map((a) => (
                  <label className="media-check" key={a.id}>
                    <input
                      type="checkbox"
                      checked={references.includes(a.id)}
                      disabled={!references.includes(a.id) && references.length >= 4}
                      onChange={(e) =>
                        setReferences(
                          e.target.checked
                            ? [...references, a.id]
                            : references.filter((id) => id !== a.id),
                        )
                      }
                    />
                    {a.name}
                  </label>
                ))}
              {!assets.some((a) => a.image) && (
                <small>
                  {tr("先在当前任务中添加图片。", "Attach an image to the current task first.")}
                </small>
              )}
            </fieldset>
            <button
              disabled={
                busy ||
                !task ||
                !selectedService ||
                !prompt.trim() ||
                !Number.isInteger(count) ||
                count < 1 ||
                count > selectedService.max_count
              }
              onClick={() => void act(generate)}
            >
              {tr("生成并保存到项目", "Generate and save to project")}
            </button>
          </div>
        )}
        {tab === "settings" && (
          <div className="media-grid">
            <div className="media-list">
              <button
                onClick={() => {
                  setService(newService());
                  setSecret("");
                }}
              >
                {tr("添加图片服务", "Add image service")}
              </button>
              {services.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setService(s);
                    setSecret("");
                  }}
                >
                  {s.label} ·{" "}
                  {s.credential ? tr("已配置密钥", "Key configured") : tr("未配置密钥", "No key")}
                </button>
              ))}
            </div>
            <div className="media-form">
              <p>
                {tr(
                  "支持独立 Images API：生成和参考图编辑。请按服务商提供的信息填写。",
                  "Supports the dedicated Images API for generation and reference-image editing. Use the information supplied by your provider.",
                )}
              </p>
              <label>
                {tr("服务名称", "Service name")}
                <input
                  value={service.label}
                  onChange={(e) => setService({ ...service, label: e.target.value })}
                />
              </label>
              <label>
                {tr("服务地址（到 /v1）", "Service base URL (ending at /v1)")}
                <input
                  value={service.base_url}
                  onChange={(e) => setService({ ...service, base_url: e.target.value })}
                />
              </label>
              <label>
                {tr("图片模型名称", "Image model name")}
                <input
                  value={service.model}
                  onChange={(e) => setService({ ...service, model: e.target.value })}
                />
              </label>
              <label>
                {tr("服务密钥（留空保留已有密钥）", "API key (blank keeps the existing key)")}
                <input
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </label>
              <details>
                <summary>{tr("服务支持的参数", "Parameters supported by the service")}</summary>
                <div className="media-form">
                  <label>
                    {tr("可选尺寸，用逗号分隔", "Allowed sizes, comma-separated")}
                    <input
                      value={service.sizes.join(",")}
                      onChange={(e) =>
                        setService({
                          ...service,
                          sizes: e.target.value.split(",").map((v) => v.trim()),
                        })
                      }
                    />
                  </label>
                  <label>
                    {tr(
                      "可选质量，用逗号分隔；可留空",
                      "Allowed quality values, comma-separated; optional",
                    )}
                    <input
                      value={service.qualities.join(",")}
                      onChange={(e) =>
                        setService({
                          ...service,
                          qualities: e.target.value
                            .split(",")
                            .map((v) => v.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </label>
                  <label>
                    {tr("可选格式，用逗号分隔", "Allowed formats, comma-separated")}
                    <input
                      value={service.formats.join(",")}
                      onChange={(e) =>
                        setService({
                          ...service,
                          formats: e.target.value.split(",").map((v) => v.trim()),
                        })
                      }
                    />
                  </label>
                  <label>
                    {tr("单次最多生成几张（1–4）", "Maximum images per request (1–4)")}
                    <input
                      type="number"
                      min={1}
                      max={4}
                      value={service.max_count}
                      onChange={(e) =>
                        setService({ ...service, max_count: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label className="media-check">
                    <input
                      type="checkbox"
                      checked={service.supports_edit}
                      onChange={(e) => setService({ ...service, supports_edit: e.target.checked })}
                    />
                    {tr("服务支持参考图编辑", "Service supports reference-image editing")}
                  </label>
                  <label className="media-check">
                    <input
                      type="checkbox"
                      checked={service.request_base64}
                      onChange={(e) => setService({ ...service, request_base64: e.target.checked })}
                    />
                    {tr(
                      "兼容服务要求显式发送 response_format=b64_json",
                      "Provider requires explicit response_format=b64_json",
                    )}
                  </label>
                  <label className="media-check">
                    <input
                      type="checkbox"
                      checked={service.auth_required}
                      onChange={(e) => setService({ ...service, auth_required: e.target.checked })}
                    />
                    {tr(
                      "需要密钥（只有本机服务可关闭）",
                      "Requires a key (can be disabled only for local services)",
                    )}
                  </label>
                </div>
              </details>
              <div className="media-actions">
                <button
                  disabled={busy || !service.label.trim() || !service.model.trim()}
                  onClick={() =>
                    void act(async () => {
                      const result = await media<{ service: ImageService }>(null, {
                        kind: "save_image_service",
                        service,
                        secret: secret || null,
                      });
                      setService(result.service);
                      setSecret("");
                      setNotice(
                        tr(
                          "配置已保存。实际生成时会验证服务返回结果。",
                          "Configuration saved. Returned images will be checked during generation.",
                        ),
                      );
                    })
                  }
                >
                  {tr("保存图片服务", "Save image service")}
                </button>
                {service.revision > 0 && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await media(null, { kind: "remove_image_service", service_id: service.id });
                        setService(newService());
                        setSecret("");
                      })
                    }
                  >
                    {tr("删除此服务配置", "Remove this service")}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {operations.length > 0 && (
          <section className="media-operations">
            <h3>{tr("生成记录与审批", "Generation records & approvals")}</h3>
            {operations.map((op) => (
              <article
                className="media-card"
                key={op.id}
                data-media-operation={op.id}
                data-operation-state={op.state}
              >
                <strong>{op.summary}</strong>
                <span>
                  {(
                    {
                      awaiting_approval: tr("等待批准", "Awaiting approval"),
                      queued: tr("等待执行", "Queued"),
                      running: tr("生成中", "Generating"),
                      completed: tr("已完成", "Completed"),
                      failed: tr("失败", "Failed"),
                      cancelled: tr("已停止", "Stopped"),
                      stopping: tr("停止中", "Stopping"),
                    } as Record<string, string>
                  )[op.state] || op.state}
                </span>
                {op.error && <p className="error">{op.error}</p>}
                {op.input && (
                  <details>
                    <summary>{tr("查看请求和来源", "View request and source")}</summary>
                    <Saved reference={op.input} />
                  </details>
                )}
                {op.state === "awaiting_approval" && (
                  <div className="media-actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await mediaWork(task!, {
                            kind: "approve",
                            operation_id: op.id,
                            fingerprint: op.fingerprint,
                          });
                        })
                      }
                    >
                      {tr("批准此生成请求", "Approve this generation")}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await mediaWork(task!, { kind: "stop", operation_id: op.id });
                        })
                      }
                    >
                      {tr("拒绝", "Reject")}
                    </button>
                  </div>
                )}
                {["running", "queued", "stopping"].includes(op.state) && (
                  <button
                    onClick={() =>
                      void act(async () => {
                        await mediaWork(task!, { kind: "stop", operation_id: op.id });
                      })
                    }
                  >
                    {tr("停止此操作", "Stop operation")}
                  </button>
                )}
                {op.output && (
                  <details>
                    <summary>{tr("完整结果与用量", "Full result & usage")}</summary>
                    <Saved reference={op.output} />
                  </details>
                )}
              </article>
            ))}
            {task && (
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await executionCommand({ kind: "start_execution", task_id: task });
                  })
                }
              >
                {tr("确认完成后继续 AI 任务", "Continue AI task after review")}
              </button>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
