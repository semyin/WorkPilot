import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  Command,
  Response,
  ProviderProfile,
  ProfileCatalog,
  ModelCallRecord,
  ModelOutput,
  ModelCapabilities,
  ModelProbeMode,
  ContentRef,
  ModelInfo,
  ProfileBundle,
} from "./generated/contracts";

const emptyCapability = () => ({
  supported: null,
  source: "unknown" as const,
  checked_at_ms: null,
});
function fresh(): ProviderProfile {
  return {
    id: crypto.randomUUID(),
    label: "",
    protocol: "chat_completions",
    base_url: "",
    model: "",
    credential: null,
    supports_tools: null,
    supports_images: null,
    revision: 1,
    auth: "auto",
    capabilities: {
      text: emptyCapability(),
      streaming: emptyCapability(),
      tools: emptyCapability(),
      images: emptyCapability(),
      usage: emptyCapability(),
    },
    options: {
      max_output_tokens: 1024,
      temperature: null,
      reasoning_effort: null,
      chat_token_parameter: "max_completion_tokens",
      timeout_ms: 90000,
      idle_timeout_ms: 30000,
      anthropic_version: "2023-06-01",
    },
    pricing: null,
  };
}
function comparable(p: ProviderProfile): string {
  const value = structuredClone(p);
  for (const key of Object.keys(value.capabilities) as (keyof ModelCapabilities)[]) {
    if (value.capabilities[key].source !== "user") value.capabilities[key] = emptyCapability();
  }
  return JSON.stringify(value);
}
async function request(command: Command): Promise<Response> {
  return invoke<Response>("engine_command", {
    request: { request_id: crypto.randomUUID(), command },
  });
}
async function readObject<T>(reference: ContentRef): Promise<T> {
  if (reference.bytes > 8 * 1024 * 1024) throw new Error("Response too large");
  let offset = 0;
  let text = "";
  do {
    const r = await request({
      kind: "read",
      query: { kind: "content", object_id: reference.object_id, offset, limit: 65536 },
    });
    if (r.kind !== "content") throw new Error("Saved response could not be read");
    text += r.page.text;
    if (r.page.next_offset <= offset && offset < r.page.total_bytes)
      throw new Error("Invalid content page");
    offset = r.page.next_offset;
    if (offset >= r.page.total_bytes) break;
  } while (offset < reference.bytes);
  return JSON.parse(text) as T;
}
export function ModelSettings({ language, onClose }: { language: string; onClose: () => void }) {
  const english = language === "en";
  const tr = (zh: string, en: string) => (english ? en : zh);
  const [catalog, setCatalog] = useState<ProfileCatalog>({ profiles: [], global_default: null });
  const [draft, setDraft] = useState(fresh);
  const [secret, setSecret] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [calls, setCalls] = useState<ModelCallRecord[]>([]);
  const [selected, setSelected] = useState<ModelCallRecord | null>(null);
  const [text, setText] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [output, setOutput] = useState<ModelOutput | null>(null);
  const [prompt, setPrompt] = useState("");
  const [exported, setExported] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const saved = catalog.profiles.find((p) => p.profile.id === draft.id);
  const dirty = !saved || comparable(saved.profile) !== comparable(draft) || !!secret || clearKey;
  const check = (r: Response) => {
    if (r.kind === "error") throw new Error(r.message);
    if (r.kind === "model_error")
      throw new Error(
        (english ? r.diagnostic.message_en : r.diagnostic.message_zh) +
          (r.diagnostic.detail ? "\n" + r.diagnostic.detail : ""),
      );
    return r;
  };
  const refresh = async () => {
    const r = check(await request({ kind: "read", query: { kind: "profiles" } }));
    if (r.kind === "profiles") {
      setCatalog(r.catalog);
      return r.catalog;
    }
  };
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    void request({ kind: "read", query: { kind: "profiles" } })
      .then((r) => {
        if (disposed) return;
        if (r.kind === "profiles") {
          setCatalog(r.catalog);
          const first =
            r.catalog.profiles.find((p) => p.profile.id === r.catalog.global_default) ||
            r.catalog.profiles[0];
          if (first) setDraft(first.profile);
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    const poll = async () => {
      try {
        const r = await request({ kind: "read", query: { kind: "model_calls", limit: 32 } });
        if (!disposed && r.kind === "model_calls") setCalls(r.calls);
      } catch (e) {
        if (!disposed) setError(String(e));
      }
      if (!disposed) timer = setTimeout(poll, 600);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  const selectedId = selected?.id;
  const selectedTask = selected?.task_id;
  useEffect(() => {
    setText("");
    setReasoning("");
    setOutput(null);
    if (!selectedId || !selectedTask) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let after = 0;
    const poll = async () => {
      try {
        const events = await request({
          kind: "read",
          query: { kind: "events", task_id: selectedTask, after, limit: 128 },
        });
        if (disposed) return;
        if (events.kind === "events") {
          let part = "";
          let thought = "";
          for (const event of events.page.events) {
            if (
              (event.kind === "model_text" || event.kind === "model_reasoning") &&
              event.call_id === selectedId
            ) {
              const data = await readObject<{ text: string }>(event.content);
              if (event.kind === "model_text") part += data.text;
              else thought += data.text;
            }
          }
          if (disposed) return;
          after = events.page.next_after;
          setText((old) => old + part);
          setReasoning((old) => old + thought);
          if (events.page.has_more) {
            timer = setTimeout(poll, 0);
            return;
          }
        }
        const r = await request({ kind: "read", query: { kind: "model_calls", limit: 64 } });
        if (disposed) return;
        if (r.kind === "model_calls") {
          const call = r.calls.find((c) => c.id === selectedId);
          if (call) {
            setSelected(call);
            if (call.state !== "running") {
              if (call.output) {
                const data = await readObject<ModelOutput>(call.output);
                if (!disposed) setOutput(data);
              }
              const updated = await request({ kind: "read", query: { kind: "profiles" } });
              if (!disposed && updated.kind === "profiles") setCatalog(updated.catalog);
              return;
            }
          }
        }
        if (!disposed) timer = setTimeout(poll, 300);
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [selectedId, selectedTask]);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const choose = (p: ProviderProfile) => {
    setDraft(p);
    setSecret("");
    setClearKey(false);
    setModels([]);
    setError("");
    setNotice("");
  };
  const save = () =>
    act(async () => {
      const r = check(
        await request({
          kind: "save_provider",
          profile: draft,
          secret: secret || null,
          clear_credential: clearKey,
        }),
      );
      if (r.kind === "provider_saved") choose(r.profile.profile);
      await refresh();
      setNotice(
        tr(
          "配置已保存。密钥保存在系统凭据库中。",
          "Saved. Keys are held in the system credential store.",
        ),
      );
    });
  const start = (mode: ModelProbeMode) =>
    act(async () => {
      const r = check(
        await request({
          kind: "start_model_probe",
          profile_id: draft.id,
          task_id: null,
          agent_id: null,
          mode,
          prompt,
        }),
      );
      if (r.kind === "model_started") setSelected(r.call);
    });
  const capabilityNames: Record<keyof ModelCapabilities, string> = {
    text: tr("文字", "Text"),
    streaming: tr("实时输出", "Streaming"),
    tools: tr("工具请求", "Tools"),
    images: tr("图片输入", "Images"),
    usage: tr("用量返回", "Usage"),
  };
  const stateLabel = (state: ModelCallRecord["state"]) =>
    ({
      running: tr("进行中", "Running"),
      completed: tr("已完成", "Completed"),
      failed: tr("失败", "Failed"),
      cancelled: tr("已停止", "Cancelled"),
      interrupted: tr("已中断", "Interrupted"),
    })[state];
  const numberOption = (key: "max_output_tokens" | "temperature", value: string) =>
    setDraft({
      ...draft,
      options: { ...draft.options, [key]: value === "" ? null : Number(value) },
    });
  const exportProfiles = () =>
    act(async () => {
      const r = check(await request({ kind: "read", query: { kind: "export_profiles" } }));
      if (r.kind === "profile_bundle") setExported(JSON.stringify(r.bundle, null, 2));
    });
  return (
    <div
      className="model-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={tr("模型服务", "Model services")}
    >
      <div className="model-header">
        <div>
          <h1>{tr("模型服务", "Model services")}</h1>
          <p>
            {tr(
              "配置你自己的服务，验证连接与实际能力。",
              "Configure your services and verify their connection and capabilities.",
            )}
          </p>
        </div>
        <button onClick={onClose}>{tr("返回工作台", "Back to workspace")}</button>
      </div>
      <div className="model-columns">
        <aside className="model-list">
          <button onClick={() => choose(fresh())} disabled={busy}>
            {tr("+ 添加服务", "+ Add service")}
          </button>
          {catalog.profiles.map((p) => (
            <button
              key={p.profile.id}
              className={draft.id === p.profile.id ? "chosen" : ""}
              onClick={() => choose(p.profile)}
              disabled={busy}
            >
              <strong>{p.profile.label}</strong>
              <small>
                {p.profile.model || tr("尚未选模型", "No model selected")}
                {catalog.global_default === p.profile.id ? " · " + tr("默认", "Default") : ""}
              </small>
            </button>
          ))}
          {!catalog.profiles.length && (
            <p>
              {tr(
                "尚未配置模型服务。填写右侧表单开始。",
                "No services configured. Start with the form.",
              )}
            </p>
          )}
          <div className="model-transfer">
            <button
              disabled={busy || !catalog.profiles.length}
              onClick={() => void exportProfiles()}
            >
              {tr("导出配置", "Export settings")}
            </button>
            <button disabled={busy} onClick={() => fileInput.current?.click()}>
              {tr("导入配置", "Import settings")}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file)
                  void act(async () => {
                    if (file.size > 900000)
                      throw new Error(tr("配置文件过大。", "Settings file is too large."));
                    const bundle = JSON.parse(await file.text()) as ProfileBundle;
                    check(await request({ kind: "import_profiles", bundle }));
                    await refresh();
                    setNotice(
                      tr(
                        "已导入为新的服务；需要重新填写密钥。",
                        "Imported as new services. Enter keys separately.",
                      ),
                    );
                  });
              }}
            />
            <small>
              {tr(
                "导出不含密钥；导入不会覆盖已有服务。",
                "Exports exclude keys; imports never overwrite existing services.",
              )}
            </small>
          </div>
          {exported && (
            <div>
              <textarea
                aria-label={tr("导出内容", "Exported settings")}
                rows={8}
                readOnly
                value={exported}
              />
              <button
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([exported], { type: "application/json" }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "workpilot-models.json";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                {tr("下载配置文件", "Download settings")}
              </button>
            </div>
          )}
        </aside>
        <section className="model-form">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="model-notice" role="status">
              {notice}
            </div>
          )}
          <fieldset disabled={busy}>
            <label>
              {tr("显示名称", "Service label")}
              <input
                value={draft.label}
                maxLength={256}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
            </label>
            <label>
              {tr("接口类型", "API protocol")}
              <select
                aria-label={tr("接口类型", "API protocol")}
                value={draft.protocol}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    protocol: e.target.value as ProviderProfile["protocol"],
                    options: { ...draft.options, reasoning_effort: null },
                  })
                }
              >
                <option value="chat_completions">Chat Completions</option>
                <option value="responses">Responses</option>
                <option value="messages">Messages</option>
              </select>
            </label>
            <label>
              {tr("服务地址", "Service URL")}
              <input
                value={draft.base_url}
                placeholder="https://api.example.com/v1"
                onChange={(e) => setDraft({ ...draft, base_url: e.target.value })}
              />
            </label>
            <label>
              {tr("模型名称", "Model name")}
              <input
                value={draft.model}
                list="model-options"
                aria-label={tr("模型名称", "Model name")}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
              <datalist id="model-options">
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name || m.id}
                  </option>
                ))}
              </datalist>
            </label>
            <small>
              {tr(
                "可以手填，也可以先保存服务、再读取模型列表。列表中出现不代表已验证可用。",
                "Type a model, or save the service and fetch its model list. Listing does not prove access.",
              )}
            </small>
            <label>
              {tr("认证方式", "Authentication")}
              <select
                aria-label={tr("认证方式", "Authentication")}
                value={draft.auth}
                onChange={(e) =>
                  setDraft({ ...draft, auth: e.target.value as ProviderProfile["auth"] })
                }
              >
                <option value="auto">{tr("按接口自动选择", "Protocol default")}</option>
                <option value="bearer">Bearer</option>
                <option value="api_key">x-api-key</option>
                <option value="none">{tr("无需密钥", "No key")}</option>
              </select>
            </label>
            <label>
              {tr("服务密钥", "Service key")}
              <input
                type="password"
                autoComplete="new-password"
                value={secret}
                disabled={draft.auth === "none" || clearKey}
                placeholder={
                  saved?.credential_saved
                    ? tr("已保存；留空保持原密钥", "Saved; leave blank to keep")
                    : tr("请填写服务提供的密钥", "Enter the service key")
                }
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
            {saved?.credential_saved && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={clearKey}
                  onChange={(e) => {
                    setClearKey(e.target.checked);
                    setSecret("");
                  }}
                />
                {tr("清除已保存的密钥", "Remove saved key")}
              </label>
            )}
            <div className="model-actions">
              <button className="primary" onClick={() => void save()}>
                {tr("保存配置", "Save settings")}
              </button>
              <button
                disabled={!saved || dirty}
                onClick={() =>
                  void act(async () => {
                    const r = check(
                      await request({ kind: "provider_models", profile_id: draft.id }),
                    );
                    if (r.kind === "models") {
                      setModels(r.models);
                      setNotice(
                        tr("已读取 ", "Loaded ") +
                          r.models.length +
                          tr(
                            " 个模型。请在模型名称中选择。",
                            " models. Select one in Model name.",
                          ) +
                          (r.has_more ? tr(" 当前仅显示第一页。", " First page only.") : ""),
                      );
                    }
                  })
                }
              >
                {tr("读取模型列表", "Fetch models")}
              </button>
              <button
                disabled={!saved || dirty || catalog.global_default === draft.id}
                onClick={() =>
                  void act(async () => {
                    check(
                      await request({
                        kind: "set_default_profile",
                        scope: { kind: "global" },
                        profile_id: draft.id,
                      }),
                    );
                    await refresh();
                  })
                }
              >
                {tr("设为全局默认", "Set global default")}
              </button>
            </div>
            {saved && (
              <p className="endpoint">
                {tr("已保存的实际请求地址", "Saved request URL")}
                <br />
                <code>{saved.endpoint}</code>
              </p>
            )}
            <details>
              <summary>{tr("能力声明与验证结果", "Capabilities and observations")}</summary>
              <p>
                {tr(
                  "能力按当前服务和模型记录；手动声明与实际测试分别标注。图片测试只证明接口接收了图片。",
                  "Capabilities belong to this service and model. Manual and observed values are labelled. Image probes verify acceptance only.",
                )}
              </p>
              {(Object.keys(capabilityNames) as (keyof ModelCapabilities)[]).map((name) => {
                const c = draft.capabilities[name];
                const observed = saved?.profile.capabilities[name];
                return (
                  <label key={name}>
                    {capabilityNames[name]}
                    <select
                      value={c.source === "user" ? String(c.supported) : "unknown"}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          capabilities: {
                            ...draft.capabilities,
                            [name]:
                              e.target.value === "unknown"
                                ? emptyCapability()
                                : {
                                    source: "user",
                                    supported: e.target.value === "true",
                                    checked_at_ms: null,
                                  },
                          },
                        })
                      }
                    >
                      <option value="unknown">{tr("未声明", "Undeclared")}</option>
                      <option value="true">{tr("声明支持", "Declared supported")}</option>
                      <option value="false">{tr("声明不支持", "Declared unsupported")}</option>
                    </select>
                    <small>
                      {observed?.source === "observed"
                        ? tr("测试观察：支持", "Observed: supported")
                        : observed?.source === "user"
                          ? tr("来源：手动声明", "Source: manual")
                          : tr("尚未验证", "Not verified")}
                    </small>
                  </label>
                );
              })}
            </details>
            <details>
              <summary>{tr("高级参数与费用估算", "Advanced options and price estimate")}</summary>
              <label>
                {tr("最大输出词元数", "Maximum output tokens")}
                <input
                  type="number"
                  value={draft.options.max_output_tokens ?? ""}
                  onChange={(e) => numberOption("max_output_tokens", e.target.value)}
                />
              </label>
              <label>
                {tr("随机程度（留空使用服务默认）", "Temperature (blank: service default)")}
                <input
                  type="number"
                  step="0.1"
                  value={draft.options.temperature ?? ""}
                  onChange={(e) => numberOption("temperature", e.target.value)}
                />
              </label>
              <label>
                {tr("总超时（秒）", "Total timeout (seconds)")}
                <input
                  type="number"
                  value={draft.options.timeout_ms / 1000}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      options: { ...draft.options, timeout_ms: Number(e.target.value) * 1000 },
                    })
                  }
                />
              </label>
              <label>
                {tr("无新内容超时（秒）", "Idle timeout (seconds)")}
                <input
                  type="number"
                  value={draft.options.idle_timeout_ms / 1000}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      options: { ...draft.options, idle_timeout_ms: Number(e.target.value) * 1000 },
                    })
                  }
                />
              </label>
              {draft.protocol !== "messages" && (
                <label>
                  {tr("推理强度（仅支持的模型使用）", "Reasoning effort (supported models only)")}
                  <select
                    value={draft.options.reasoning_effort || ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        options: { ...draft.options, reasoning_effort: e.target.value || null },
                      })
                    }
                  >
                    {["", "none", "minimal", "low", "medium", "high", "xhigh"].map((v) => (
                      <option key={v} value={v}>
                        {v || tr("不发送", "Omit")}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {draft.protocol === "chat_completions" && (
                <label>
                  {tr("输出长度参数", "Output limit field")}
                  <select
                    value={draft.options.chat_token_parameter}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        options: {
                          ...draft.options,
                          chat_token_parameter: e.target.value as
                            "max_tokens" | "max_completion_tokens",
                        },
                      })
                    }
                  >
                    <option>max_completion_tokens</option>
                    <option>max_tokens</option>
                  </select>
                </label>
              )}
              {draft.protocol === "messages" && (
                <label>
                  anthropic-version
                  <input
                    value={draft.options.anthropic_version}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        options: { ...draft.options, anthropic_version: e.target.value },
                      })
                    }
                  />
                </label>
              )}
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={!!draft.pricing}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      pricing: e.target.checked
                        ? {
                            currency: "USD",
                            input_microunits_per_million: 0,
                            output_microunits_per_million: 0,
                          }
                        : null,
                    })
                  }
                />
                {tr("按我的单价估算费用", "Estimate cost using my prices")}
              </label>
              {draft.pricing && (
                <>
                  <label>
                    {tr("币种", "Currency")}
                    <input
                      value={draft.pricing.currency}
                      maxLength={3}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          pricing: { ...draft.pricing!, currency: e.target.value.toUpperCase() },
                        })
                      }
                    />
                  </label>
                  {(["input", "output"] as const).map((side) => (
                    <label key={side}>
                      {side === "input"
                        ? tr("每百万输入词元单价", "Price per million input tokens")
                        : tr("每百万输出词元单价", "Price per million output tokens")}
                      <input
                        type="number"
                        step="0.000001"
                        value={
                          draft.pricing![
                            side === "input"
                              ? "input_microunits_per_million"
                              : "output_microunits_per_million"
                          ] / 1000000
                        }
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            pricing: {
                              ...draft.pricing!,
                              [side === "input"
                                ? "input_microunits_per_million"
                                : "output_microunits_per_million"]: Math.round(
                                Number(e.target.value) * 1000000,
                              ),
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                </>
              )}
              <small>
                {tr(
                  "未知用量或单价时不估算；估算不等于服务账单。",
                  "Unknown usage or prices are never treated as zero. Estimates are not invoices.",
                )}
              </small>
            </details>
          </fieldset>
          <section className="connection-test">
            <h2>{tr("连接测试", "Connection test")}</h2>
            <p>
              {tr(
                "发送一次真实请求。出错直接停止，不重试、不切换模型。",
                "Sends one real request. Errors stop the call, with no retry or model fallback.",
              )}
            </p>
            <label>
              {tr("测试要求（可留空）", "Test prompt (optional)")}
              <textarea
                rows={2}
                value={prompt}
                maxLength={16384}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
            <div className="model-actions">
              {(["text", "tools", "image"] as const).map((mode) => (
                <button
                  key={mode}
                  disabled={busy || dirty || !draft.model}
                  onClick={() => void start(mode)}
                >
                  {mode === "text"
                    ? tr("测试文字", "Test text")
                    : mode === "tools"
                      ? tr("测试工具请求", "Test tools")
                      : tr("测试图片输入", "Test image")}
                </button>
              ))}
            </div>
            <small>
              {dirty
                ? tr("请先保存修改，再进行测试。", "Save changes before testing.")
                : tr(
                    "工具测试只接收工具提议；图片测试发送一张固定小图片。",
                    "Tools are inspected, never executed. Image tests send a fixed small image.",
                  )}
            </small>
          </section>
        </section>
        <aside className="model-results">
          <h2>{tr("调用记录", "Call history")}</h2>
          <label>
            {tr("最近的调用", "Recent calls")}
            <select
              value={selected?.id || ""}
              onChange={(e) => setSelected(calls.find((c) => c.id === e.target.value) || null)}
            >
              <option value="">{tr("选择一条记录", "Select a call")}</option>
              {calls.map((c) => (
                <option key={c.id} value={c.id}>
                  {new Date(c.started_at_ms).toLocaleTimeString()} · {c.profile_snapshot.label} ·{" "}
                  {stateLabel(c.state)}
                </option>
              ))}
            </select>
          </label>
          {!selected && (
            <p>
              {tr(
                "测试后会在这里显示实时回复、错误和实际用量。关闭设置不会停止调用。",
                "Live output, errors and actual usage appear here. Closing settings does not stop calls.",
              )}
            </p>
          )}
          {selected && (
            <>
              <div className="model-call-status" data-state={selected.state}>
                <strong>{stateLabel(selected.state)}</strong>
                {selected.state === "running" && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const r = check(
                          await request({ kind: "cancel_model_probe", call_id: selected.id }),
                        );
                        if (r.kind === "model_started") setSelected(r.call);
                      })
                    }
                  >
                    {tr("停止调用", "Stop call")}
                  </button>
                )}
              </div>
              <p>
                {selected.profile_snapshot.model} · {tr("配置版本 ", "Settings revision ")}
                {selected.profile_revision}
              </p>
              {selected.diagnostic && (
                <div className="error" role="alert">
                  {english ? selected.diagnostic.message_en : selected.diagnostic.message_zh}
                  {selected.diagnostic.detail && (
                    <details>
                      <summary>{tr("错误详情（已脱敏）", "Sanitized details")}</summary>
                      <pre>{selected.diagnostic.detail}</pre>
                    </details>
                  )}
                </div>
              )}
              <pre className="model-response" data-testid="model-response">
                {output?.text || text || tr("尚无文字回复", "No text output yet")}
              </pre>
              {!!reasoning && (
                <details>
                  <summary>{tr("服务公开的推理内容", "Reasoning shared by the service")}</summary>
                  <pre>{reasoning}</pre>
                </details>
              )}
              {!!output?.tool_calls.length && (
                <div>
                  <h3>{tr("工具请求（未执行）", "Tool requests (not executed)")}</h3>
                  <pre data-testid="model-tools">{JSON.stringify(output.tool_calls, null, 2)}</pre>
                </div>
              )}
              {selected.state !== "running" && (
                <div className="model-usage">
                  <p>
                    {tr("输入词元：", "Input tokens: ")}
                    {selected.usage?.input_tokens ?? tr("未知", "Unknown")}
                  </p>
                  <p>
                    {tr("输出词元：", "Output tokens: ")}
                    {selected.usage?.output_tokens ?? tr("未知", "Unknown")}
                  </p>
                  <p>
                    {tr("费用估算：", "Estimated cost: ")}
                    {selected.usage?.cost_microunits != null
                      ? (selected.usage.cost_microunits / 1000000).toFixed(6) +
                        " " +
                        selected.usage.currency
                      : tr("未知", "Unknown")}
                  </p>
                </div>
              )}
              {output && (
                <details>
                  <summary>
                    {tr("完整响应与续接数据", "Complete response and continuation data")}
                  </summary>
                  <pre>{JSON.stringify(output, null, 2)}</pre>
                </details>
              )}
              <details>
                <summary>{tr("本次配置快照", "Settings used for this call")}</summary>
                <pre>{JSON.stringify(selected.profile_snapshot, null, 2)}</pre>
              </details>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
