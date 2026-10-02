CREATE TABLE team_settings(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, data_json TEXT NOT NULL CHECK(json_valid(data_json)));
CREATE TABLE team_control(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE team_members(
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
 root_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
 member_key TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)),
 pending_start INTEGER NOT NULL DEFAULT 1,
 report_object_id TEXT REFERENCES objects(id), report_run_id TEXT,
 inspected_object_id TEXT REFERENCES objects(id), review TEXT NOT NULL DEFAULT 'pending', review_reason TEXT,
 superseded_by TEXT REFERENCES tasks(id),
 UNIQUE(parent_task_id,member_key)
);
CREATE TABLE team_dependencies(member_id TEXT NOT NULL REFERENCES team_members(task_id) ON DELETE CASCADE, dependency_id TEXT NOT NULL REFERENCES team_members(task_id), PRIMARY KEY(member_id,dependency_id));
CREATE TABLE team_action_receipts(action_id TEXT PRIMARY KEY REFERENCES execution_steps(id) ON DELETE CASCADE, object_id TEXT NOT NULL REFERENCES objects(id));
CREATE TABLE team_waiters(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, action_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE, members_json TEXT NOT NULL CHECK(json_valid(members_json)));
CREATE INDEX team_parent ON team_members(parent_task_id);
CREATE INDEX team_root ON team_members(root_task_id);
