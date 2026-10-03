-- Legacy P01 schedule placeholders stay inert until explicitly re-created.
CREATE TABLE schedule_cursor (
  schedule_id TEXT PRIMARY KEY REFERENCES schedules(id),
  revision INTEGER NOT NULL,
  enabled INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  next_at_ms INTEGER,
  high_water_ms INTEGER NOT NULL
);
CREATE INDEX schedule_due ON schedule_cursor(enabled,deleted,next_at_ms);
CREATE TABLE schedule_occurrences (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  revision INTEGER NOT NULL,
  due_at_ms INTEGER NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  reason TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  plan_object_id TEXT NOT NULL REFERENCES objects(id),
  missed_count INTEGER,
  missed_until_ms INTEGER
);
CREATE INDEX schedule_history ON schedule_occurrences(schedule_id,sequence DESC);
CREATE UNIQUE INDEX schedule_task ON schedule_occurrences(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX schedule_claimed ON schedule_occurrences(schedule_id,state);
CREATE TABLE schedule_commands (
  request_id TEXT PRIMARY KEY REFERENCES commands(request_id),
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  occurrence_id TEXT REFERENCES schedule_occurrences(id)
);
