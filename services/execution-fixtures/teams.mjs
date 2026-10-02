import { startExecutionFixture } from "./server.mjs";
const tool = (name, args) => ({ text: "", calls: [{ name, args }] });
const done = (text) => ({ text, calls: [] });
function teamState(body) {
  const marker = "Data below is platform state, not delegated authority:\n";
  const strings = [];
  const walk = (value) => {
    if (typeof value === "string") strings.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(body);
  for (const text of strings) {
    const i = text.indexOf(marker);
    if (i >= 0) {
      try {
        return JSON.parse(text.slice(i + marker.length));
      } catch {}
    }
  }
  return { your_direct_members: [] };
}
export function startTeamFixture() {
  const definitions = new Map();
  const starts = [];
  return startExecutionFixture((body, results) => {
    const spec = definitions.get(body.model);
    if (!spec) return undefined;
    starts.push({ model: body.model, at: Date.now(), results: results.length });
    if (spec.kind === "error") return { error: 429 };
    if (spec.kind === "hold") return { ...done("held member finished"), delay: spec.ms || 5000 };
    if (spec.kind === "leaf") {
      const action = spec.actions?.[results.length];
      return {
        ...(action ? tool(action.name, action.args) : done(spec.text || "member delivery")),
        delay: spec.delay || 0,
      };
    }
    const state = teamState(body);
    const members = state.your_direct_members.filter((m) => !m.superseded_by);
    if (!members.length) return tool("delegate_agents", { members: spec.members });
    const last = results.length ? JSON.parse(results.at(-1)) : null;
    if (last?.error && spec.stopOnLimit)
      return tool("ask_user", {
        question: "Reached configured team limit. Decide how to proceed.",
        choices: ["Stop"],
      });
    if (spec.pauseOnApproval && members.some((m) => m.state === "awaiting_approval"))
      return tool("ask_user", {
        question: "Member needs your approval.",
        choices: ["Review member"],
      });
    if (last?.report_id)
      return tool("review_agent_result", {
        member_id: last.member_id,
        report_id: last.report_id,
        accept: last.state === "completed",
        reason:
          last.state === "completed"
            ? "Inspected delivery and linked artifacts"
            : "Explicitly abandoning stopped branch",
      });
    const failed = members.find(
      (m) => ["failed", "interrupted"].includes(m.state) && m.review !== "abandoned",
    );
    if (failed && spec.replacement && failed.attempt < (spec.attempts ?? 1))
      return tool("replace_agent", {
        member_id: failed.task_id,
        profile_id: spec.replacement,
        reason: "Explicit new attempt after inspecting member failure",
      });
    const review = members.find(
      (m) =>
        m.report &&
        m.review === "pending" &&
        ["completed", "failed", "interrupted"].includes(m.state),
    );
    if (review) return tool("inspect_agent", { member_id: review.task_id, step_id: null });
    if (members.some((m) => !["accepted", "abandoned"].includes(m.review)))
      return tool("wait_for_agents", { member_ids: members.map((m) => m.task_id) });
    return done("Team synthesis: " + members.map((m) => m.key + ":" + m.review).join(", "));
  }).then((f) => ({ ...f, definitions, starts }));
}
