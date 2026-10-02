ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1));
CREATE TABLE project_workspace (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, rules TEXT NOT NULL DEFAULT '', root_identity TEXT, revision INTEGER NOT NULL DEFAULT 1);
CREATE INDEX tasks_workspace ON tasks(archived,project_id,updated_at_ms DESC,id DESC);
CREATE INDEX events_conversation ON events(task_id,json_extract(payload_json,'$.kind'),sequence);
CREATE TABLE workspace_exports(request_id TEXT PRIMARY KEY REFERENCES commands(request_id) ON DELETE CASCADE, result_json TEXT);
