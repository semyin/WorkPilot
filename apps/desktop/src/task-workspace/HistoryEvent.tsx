import { useState } from "react";
import type { ContentRef, Event as EngineEvent } from "../generated/contracts";
import { Saved } from "../SavedContent";
export function HistoryEvent({ event }: { event: EngineEvent }) {
  const [expanded, setExpanded] = useState(false);
  const references: ContentRef[] = [];
  if ("content" in event && event.content) references.push(event.content);
  if (event.kind === "context_compacted") references.push(event.archive);
  if (event.kind === "execution_created") references.push(event.goal);
  if (event.kind === "execution_ended" && event.output) references.push(event.output);
  if (event.kind === "team_changed" && event.record) references.push(event.record);
  if (event.kind === "workbench_changed" && event.record) references.push(event.record);
  if (event.kind === "execution_step_changed") {
    if (event.input) references.push(event.input);
    if (event.output) references.push(event.output);
  }
  return (
    <details onToggle={(e) => setExpanded(e.currentTarget.open)}>
      <summary>
        #{event.task_sequence} · {event.kind}
      </summary>
      {expanded && (
        <>
          <pre>{JSON.stringify(event, null, 2)}</pre>
          {references.map((r) => (
            <Saved key={r.object_id} reference={r} plain={r.media_type !== "application/json"} />
          ))}
        </>
      )}
    </details>
  );
}
