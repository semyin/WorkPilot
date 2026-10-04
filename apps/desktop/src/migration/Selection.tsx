import type { MigrationSelection } from "../generated/contracts";
import { useWords } from "../workspaceClient";
import type { Catalog } from "./client";
export function MigrationSelectionForm({
  catalog,
  selected,
  onChange,
  disabled,
}: {
  catalog: Catalog;
  selected: MigrationSelection[];
  onChange: (value: MigrationSelection[]) => void;
  disabled: boolean;
}) {
  const tr = useWords();
  const update = (project: string, change: Partial<MigrationSelection>) =>
    onChange(selected.map((s) => (s.project_id === project ? { ...s, ...change } : s)));
  const toggle = (items: string[], id: string) =>
    items.includes(id) ? items.filter((s) => s !== id) : [...items, id];
  return (
    <fieldset disabled={disabled}>
      <legend>{tr("选择要搬迁的资料", "Select data to migrate")}</legend>
      {catalog.projects.map((project, projectIndex) => {
        const s = selected.find((s) => s.project_id === project.id);
        const extensions = catalog.extensions.find((e) => e.project_id === project.id)?.catalog;
        return (
          <div key={project.id} className="transfer-preview">
            <label>
              <input
                type="checkbox"
                checked={!!s}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [
                          ...selected,
                          {
                            project_id: project.id,
                            profile_ids: [],
                            memory_ids: [],
                            task_ids: [],
                            files: [],
                            extensions: [],
                            draft_ids: [],
                          },
                        ]
                      : selected.filter((s) => s.project_id !== project.id),
                  )
                }
              />
              {project.settings.name}
            </label>
            {s && (
              <>
                <details open>
                  <summary>{tr("模型配置（密钥不导出）", "Models (credentials excluded)")}</summary>
                  {catalog.profiles.map((p) => (
                    <label key={p.id}>
                      <input
                        type="checkbox"
                        checked={s.profile_ids.includes(p.id)}
                        onChange={() =>
                          update(project.id, { profile_ids: toggle(s.profile_ids, p.id) })
                        }
                      />
                      {p.label} · {p.model}
                    </label>
                  ))}
                </details>
                <details>
                  <summary>
                    {tr(
                      "会话、助手、附件和文件历史",
                      "Conversations, assistants, attachments and file history",
                    )}
                  </summary>
                  {catalog.tasks
                    .filter(
                      (t) => t.project_id === project.id || (projectIndex === 0 && !t.project_id),
                    )
                    .map((t) => (
                      <label key={t.id}>
                        <input
                          type="checkbox"
                          checked={s.task_ids.includes(t.id)}
                          onChange={() =>
                            update(project.id, { task_ids: toggle(s.task_ids, t.id) })
                          }
                        />
                        {t.title} · {t.state}
                      </label>
                    ))}
                </details>
                <details>
                  <summary>{tr("记忆及全部保存版本", "Memories and all saved versions")}</summary>
                  {catalog.memories
                    .filter(
                      (m) => m.project_id === project.id || (projectIndex === 0 && !m.project_id),
                    )
                    .map((m) => (
                      <label key={m.id}>
                        <input
                          type="checkbox"
                          checked={s.memory_ids.includes(m.id)}
                          onChange={() =>
                            update(project.id, { memory_ids: toggle(s.memory_ids, m.id) })
                          }
                        />
                        {m.text.slice(0, 100)} · {m.state}
                      </label>
                    ))}
                </details>
                <details>
                  <summary>
                    {tr(
                      "技能、插件和草稿（含旧版本）",
                      "Skills, plugins and drafts (including old versions)",
                    )}
                  </summary>
                  {extensions?.items
                    .filter((e) => e.installation.scope !== null || projectIndex === 0)
                    .map((e) => (
                      <label key={e.installation.id}>
                        <input
                          type="checkbox"
                          checked={s.extensions.some(
                            (p) => p.installation_id === e.installation.id,
                          )}
                          onChange={() =>
                            update(project.id, {
                              extensions: s.extensions.some(
                                (p) => p.installation_id === e.installation.id,
                              )
                                ? s.extensions.filter(
                                    (p) => p.installation_id !== e.installation.id,
                                  )
                                : [
                                    ...s.extensions,
                                    {
                                      installation_id: e.installation.id,
                                      revision: e.installation.revision,
                                    },
                                  ],
                            })
                          }
                        />
                        {e.version.manifest.name}
                      </label>
                    ))}
                  {extensions?.drafts
                    .filter((e) => e.scope !== null || projectIndex === 0)
                    .map((e) => (
                      <label key={e.id}>
                        <input
                          type="checkbox"
                          checked={s.draft_ids.includes(e.id)}
                          onChange={() =>
                            update(project.id, { draft_ids: toggle(s.draft_ids, e.id) })
                          }
                        />
                        {tr("草稿 ", "Draft ")}
                        {e.version?.manifest.name || e.id}
                      </label>
                    ))}
                </details>
                <label>
                  {tr(
                    "当前项目文件：每行一个相对路径",
                    "Current project files: one relative path per line",
                  )}
                  <textarea
                    value={s.files.join("\n")}
                    placeholder={"资料/说明.txt\nreports/result.pdf"}
                    onChange={(e) => update(project.id, { files: e.target.value.split("\n") })}
                    onBlur={() =>
                      update(project.id, { files: s.files.map((p) => p.trim()).filter(Boolean) })
                    }
                  />
                </label>
              </>
            )}
          </div>
        );
      })}
      {!catalog.projects.length && (
        <p>
          {tr(
            "先创建一个项目；仅模型配置也可使用原模型导入导出入口。",
            "Create a project first; standalone model configuration transfer remains available in model settings.",
          )}
        </p>
      )}
    </fieldset>
  );
}
