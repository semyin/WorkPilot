CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  data_json TEXT NOT NULL,
  original_blob TEXT NOT NULL,
  parsed_blob TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX media_task ON media_assets(task_id, removed);
CREATE TABLE image_services (
  id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL
);
