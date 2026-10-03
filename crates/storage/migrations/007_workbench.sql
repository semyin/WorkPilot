CREATE TABLE workbench_operations (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 fingerprint TEXT NOT NULL, spec_blob TEXT, started INTEGER NOT NULL DEFAULT 0, data_json TEXT NOT NULL CHECK(json_valid(data_json))
);
CREATE TABLE file_revisions (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 root_identity TEXT NOT NULL, path TEXT NOT NULL, operation_id TEXT NOT NULL,
 data_json TEXT NOT NULL CHECK(json_valid(data_json)), UNIQUE(operation_id,path)
);
CREATE INDEX file_revisions_root_path ON file_revisions(root_identity,path);
CREATE TABLE workbench_output_objects (
 operation_id TEXT NOT NULL REFERENCES workbench_operations(id) ON DELETE CASCADE,
 object_id TEXT NOT NULL REFERENCES objects(id),
 PRIMARY KEY(operation_id,object_id)
);
CREATE TABLE file_captures (
 operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 root_path TEXT NOT NULL, root_identity TEXT NOT NULL, source TEXT NOT NULL,
 data_json TEXT NOT NULL CHECK(json_valid(data_json)), state TEXT NOT NULL
);
