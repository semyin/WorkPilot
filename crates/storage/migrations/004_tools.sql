CREATE TABLE task_tool_settings (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 data_json TEXT NOT NULL CHECK(json_valid(data_json)), root_identity TEXT
);
CREATE TABLE managed_file_changes (
 action_id TEXT PRIMARY KEY REFERENCES execution_steps(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, path TEXT NOT NULL, root_identity TEXT NOT NULL,
 before_json TEXT NOT NULL, after_json TEXT,
 before_object_id TEXT REFERENCES objects(id), after_object_id TEXT NOT NULL REFERENCES objects(id)
);
CREATE TABLE tool_approval_objects (
 approval_id TEXT PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
 action_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,
 intent_object_id TEXT NOT NULL REFERENCES objects(id)
);
CREATE INDEX tool_approval_action ON tool_approval_objects(action_id);
CREATE TABLE tool_result_objects (
 action_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,
 object_id TEXT NOT NULL REFERENCES objects(id),
 PRIMARY KEY(action_id,object_id)
);
