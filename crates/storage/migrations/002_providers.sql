CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL CHECK(json_valid(value_json)));
CREATE TABLE profile_versions (
 profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 PRIMARY KEY(profile_id,revision)
);
CREATE TABLE model_calls (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES commands(request_id),
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 profile_id TEXT NOT NULL, profile_revision INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), mode TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('running','completed','failed','cancelled','interrupted')),
 started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
 output_object_id TEXT REFERENCES objects(id), diagnostic_json TEXT, usage_json TEXT,
 CHECK(state <> 'completed' OR (output_object_id IS NOT NULL AND ended_at_ms IS NOT NULL))
);
CREATE INDEX model_calls_history ON model_calls(started_at_ms DESC,id DESC);
CREATE TABLE capability_observations (
 profile_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, capability TEXT NOT NULL, supported INTEGER NOT NULL,
 checked_at_ms INTEGER NOT NULL, PRIMARY KEY(profile_id,revision,capability)
);
