CREATE TABLE outcomes (
  job_id TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('interviewing','offered','accepted','rejected','withdrawn','closed')),
  note TEXT NOT NULL CHECK(length(note)<=2000),
  next_action_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX outcomes_owner ON outcomes(user_id);
