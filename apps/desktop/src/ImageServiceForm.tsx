import type { Dispatch, SetStateAction } from "react";
import type { ImageService } from "./generated/contracts";
import { media } from "./mediaClient";
import { useWords } from "./workspaceClient";

export function ImageServiceForm({
  service,
  setService,
  secret,
  setSecret,
  busy,
  act,
  setNotice,
  newService,
}: {
  service: ImageService;
  setService: Dispatch<SetStateAction<ImageService>>;
  secret: string;
  setSecret: Dispatch<SetStateAction<string>>;
  busy: boolean;
  act: (operation: () => Promise<void>) => Promise<void>;
  setNotice: Dispatch<SetStateAction<string>>;
  newService: () => ImageService;
}) {
  const tr = useWords();
  return (
    <div className="media-form">
      <p>
        {tr(
          "支持独立 Images API：生成和参考图编辑。请按服务商提供的信息填写。",
          "Supports the dedicated Images API for generation and reference-image editing. Use the information supplied by your provider.",
        )}
      </p>
      <label>
        {tr("图片接口类型", "Image API type")}
        <select
          value={service.protocol}
          onChange={(event) => {
            const aliyun = event.target.value === "aliyun_images";
            setService({
              ...service,
              protocol: aliyun ? "aliyun_images" : "openai_images",
              ...(aliyun
                ? {
                    formats: ["png"],
                    qualities: [],
                    request_base64: false,
                    model: service.model || "qwen-image-3.0",
                    base_url:
                      service.base_url === "https://api.openai.com/v1" ? "" : service.base_url,
                  }
                : {}),
            });
          }}
        >
          <option value="openai_images">
            {tr("通用 Images（返回图片内容）", "Standard Images (image bytes)")}
          </option>
          <option value="aliyun_images">
            {tr("阿里云百炼 / Qwen Image", "Alibaba Cloud Bailian / Qwen Image")}
          </option>
        </select>
      </label>
      {service.protocol === "aliyun_images" && (
        <p className="execution-notice">
          {tr(
            "填写你的业务空间 OpenAI 兼容地址。生成和参考图编辑均输出 PNG；服务返回的官方图片链接会下载并核验，不向图片下载地址发送模型密钥。",
            "Enter your workspace's OpenAI-compatible base URL. Generation and editing use PNG. Official result links are downloaded and validated without sending the model key to the download host.",
          )}
        </p>
      )}
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
              onChange={(e) => setService({ ...service, max_count: Number(e.target.value) })}
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
              disabled={service.protocol === "aliyun_images"}
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
  );
}
