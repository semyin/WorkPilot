import appIcon from "../../../../assets/icons/png/128.png";
import { Icon, type IconName } from "./Icon";
import { useWords } from "../workspaceClient";

export function NewTaskWelcome({ onPrompt }: { onPrompt: (text: string) => void }) {
  const tr = useWords();
  const suggestions: Array<[IconName, string, string]> = [
    [
      "folder",
      tr("理解一个项目", "Understand a project"),
      tr(
        "帮我梳理这个项目的结构，给出一份改进计划。",
        "Review this project's structure and propose an improvement plan.",
      ),
    ],
    [
      "files",
      tr("整理资料与要点", "Organize notes and takeaways"),
      tr(
        "整理我提供的资料，提取要点和需要跟进的事项。",
        "Organize the material I provide and identify key points and follow-ups.",
      ),
    ],
    [
      "edit",
      tr("制作一份文档", "Create a document"),
      tr(
        "根据需求制作一份清晰的文档，并保留可编辑的源文件。",
        "Create a clear document from my requirements and keep an editable source.",
      ),
    ],
  ];
  return (
    <section className="wb-new-work">
      <img className="wb-welcome-mark" src={appIcon} alt="" />
      <h2>{tr("开始一项新工作", "Start something new")}</h2>
      <p>
        {tr(
          "描述目标，添加资料，剩下的一起完成。",
          "Describe your goal, add your material, and we'll take it from there.",
        )}
      </p>
      <div className="wb-suggestions">
        {suggestions.map(([icon, label, prompt]) => (
          <button type="button" key={icon} onClick={() => onPrompt(prompt)}>
            <Icon name={icon} />
            {label}
            <Icon name="right" />
          </button>
        ))}
      </div>
    </section>
  );
}
