CREATE TABLE memory_meta (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  search_text TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
);
CREATE TABLE memory_versions (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  object_id TEXT NOT NULL REFERENCES objects(id),
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  PRIMARY KEY(memory_id,revision)
);
CREATE TABLE memory_commands (
  request_id TEXT PRIMARY KEY REFERENCES commands(request_id),
  memory_id TEXT NOT NULL REFERENCES memories(id)
);
CREATE TABLE memory_proposals (
  action_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  memory_id TEXT NOT NULL REFERENCES memories(id)
);
-- Earlier phases only stored Memory placeholders. Preserve their original objects;
-- unconfirmed legacy entries never acquire confirmation in this migration.
INSERT INTO memory_meta(memory_id,revision,deleted,search_text,data_json)
SELECT id,0,0,'',json_object('memory',json(data_json),'revision',0,'deleted',json('false'),
  'source_label','早期记录 / Legacy record','source_quote','','created_at_ms',0,
  'updated_at_ms',0,'change','legacy') FROM memories;
INSERT INTO memory_versions(memory_id,revision,object_id,data_json)
SELECT m.id,0,m.object_id,x.data_json FROM memories m JOIN memory_meta x ON x.memory_id=m.id;
