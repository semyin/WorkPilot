CREATE TABLE provider_profiles (id TEXT PRIMARY KEY, data_json TEXT NOT NULL CHECK(json_valid(data_json)));
CREATE TABLE projects (id TEXT PRIMARY KEY, root_path TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)));
CREATE TABLE tasks (
 id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
 title TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','running','awaiting_input','awaiting_approval','stopping','interrupted','failed','completed')),
 mode TEXT NOT NULL, permission TEXT NOT NULL, profile_id TEXT REFERENCES provider_profiles(id),
 created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE agents (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 parent_id TEXT REFERENCES agents(id), data_json TEXT NOT NULL CHECK(json_valid(data_json)));
CREATE TABLE objects (id TEXT PRIMARY KEY CHECK(length(id)=64), bytes INTEGER NOT NULL, media_type TEXT NOT NULL);
CREATE TABLE runs (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, agent_id TEXT REFERENCES agents(id),
 state TEXT NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
 result_object_id TEXT REFERENCES objects(id), failure_code TEXT,
 CHECK(state <> 'completed' OR (result_object_id IS NOT NULL AND ended_at_ms IS NOT NULL))
);
CREATE TABLE messages (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 role TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','steer_requested','delivered','cancelled')),
 queue_position INTEGER NOT NULL, object_id TEXT NOT NULL REFERENCES objects(id), created_at_ms INTEGER NOT NULL,
 UNIQUE(task_id, queue_position)
);
CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 data_json TEXT NOT NULL CHECK(json_valid(data_json)));
CREATE TABLE tool_calls (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, agent_id TEXT REFERENCES agents(id),
 name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('started','succeeded','failed','needs_review')),
 input_object_id TEXT NOT NULL REFERENCES objects(id), output_object_id TEXT REFERENCES objects(id),
 approval_id TEXT REFERENCES approvals(id), started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
 CHECK(state <> 'succeeded' OR (output_object_id IS NOT NULL AND ended_at_ms IS NOT NULL))
);
CREATE TABLE artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 path TEXT NOT NULL, latest_revision_id TEXT);
CREATE TABLE revisions (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 object_id TEXT NOT NULL REFERENCES objects(id), predecessor_id TEXT REFERENCES revisions(id), created_at_ms INTEGER NOT NULL);
CREATE TABLE schedules (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
 object_id TEXT NOT NULL REFERENCES objects(id), data_json TEXT NOT NULL CHECK(json_valid(data_json)));
CREATE TABLE memories (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
 source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
 object_id TEXT NOT NULL REFERENCES objects(id), data_json TEXT NOT NULL CHECK(json_valid(data_json)));
-- Tombstones survive task deletion so a delayed retry cannot recreate deleted work.
-- Only a one-way fingerprint is retained, never raw command text or credentials.
CREATE TABLE commands (
 request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, command_kind TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('accepted','completed','failed','interrupted')),
 task_id TEXT, accepted_at_ms INTEGER NOT NULL, finished_at_ms INTEGER
);
CREATE TABLE events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence <= 9007199254740991),
 event_id TEXT NOT NULL UNIQUE, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
 task_sequence INTEGER, agent_id TEXT, source TEXT NOT NULL, at_ms INTEGER NOT NULL,
 request_id TEXT, payload_json TEXT NOT NULL CHECK(length(payload_json) <= 65536 AND json_valid(payload_json)),
 UNIQUE(task_id, task_sequence)
);
CREATE INDEX events_task_sequence ON events(task_id, sequence);
CREATE INDEX runs_task ON runs(task_id);
CREATE INDEX tools_task ON tool_calls(task_id, state);
CREATE INDEX messages_queue ON messages(task_id, state, queue_position);
CREATE TABLE event_objects (
 event_sequence INTEGER NOT NULL REFERENCES events(sequence) ON DELETE CASCADE,
 object_id TEXT NOT NULL REFERENCES objects(id), PRIMARY KEY(event_sequence, object_id)
);
