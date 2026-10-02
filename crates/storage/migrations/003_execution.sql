CREATE TABLE execution_sessions (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
 config_object_id TEXT NOT NULL REFERENCES objects(id), context_object_id TEXT NOT NULL REFERENCES objects(id),
 current_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL, checkpoint_id TEXT,
 UNIQUE(task_id,agent_id)
);
CREATE TABLE execution_runs (
 run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES execution_sessions(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL REFERENCES commands(request_id), predecessor_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
 profile_json TEXT NOT NULL CHECK(json_valid(profile_json)), mode TEXT NOT NULL,
 limits_json TEXT NOT NULL CHECK(json_valid(limits_json)), steps INTEGER NOT NULL DEFAULT 0,
 reason TEXT, diagnostic_json TEXT
);
CREATE TABLE execution_checkpoints (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES execution_sessions(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, predecessor_id TEXT,
 context_object_id TEXT NOT NULL REFERENCES objects(id), phase TEXT NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE TABLE execution_steps (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('model','tool')), name TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','running','completed','failed','cancelled','skipped','needs_review')),
 provider_call_id TEXT, input_object_id TEXT NOT NULL REFERENCES objects(id),
 output_object_id TEXT REFERENCES objects(id), tool_call_id TEXT REFERENCES tool_calls(id) ON DELETE SET NULL,
 started_at_ms INTEGER, ended_at_ms INTEGER, UNIQUE(run_id,ordinal)
);
CREATE TABLE controlled_effects (
 action_id TEXT PRIMARY KEY REFERENCES execution_steps(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES execution_sessions(id) ON DELETE CASCADE,
 name TEXT NOT NULL, output_object_id TEXT NOT NULL REFERENCES objects(id), created_at_ms INTEGER NOT NULL
);
CREATE INDEX execution_steps_run ON execution_steps(run_id,ordinal);
CREATE INDEX execution_runs_session ON execution_runs(session_id);
CREATE INDEX controlled_effects_name ON controlled_effects(session_id,name,created_at_ms);
CREATE TABLE execution_resolutions (
 action_id TEXT PRIMARY KEY REFERENCES execution_steps(id) ON DELETE CASCADE,
 output_object_id TEXT NOT NULL REFERENCES objects(id), request_id TEXT NOT NULL REFERENCES commands(request_id)
);
