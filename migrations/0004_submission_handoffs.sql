-- Candidate-controlled handoffs only. No browser credentials or document bodies.
CREATE TABLE submission_intents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  job_revision INTEGER NOT NULL CHECK(job_revision > 0),
  draft_revision INTEGER NOT NULL CHECK(draft_revision > 0),
  profile_id TEXT,
  profile_revision INTEGER NOT NULL,
  destination TEXT NOT NULL CHECK(length(destination) <= 2048),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
  approved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('approved','requires_user','submitted','cancelled','expired','stale')),
  updated_at TEXT NOT NULL
);
CREATE INDEX submission_owner ON submission_intents(user_id,approved_at DESC);
CREATE UNIQUE INDEX submission_active_job ON submission_intents(user_id,job_id)
  WHERE status IN ('approved','requires_user','submitted');
CREATE TABLE submission_attempts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES submission_intents(id) ON DELETE CASCADE,
  opened_at TEXT NOT NULL,
  confirmed_at TEXT,
  receipt TEXT CHECK(receipt IS NULL OR length(receipt) BETWEEN 8 AND 500)
);
CREATE TRIGGER submission_quota BEFORE INSERT ON submission_intents BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM submission_intents WHERE user_id=NEW.user_id) >= 250
    THEN RAISE(ABORT,'submission history limit') END;
END;
-- Synchronous invalidation closes read/check/write races, including profile removal.
CREATE TRIGGER submission_record_changed AFTER UPDATE ON records BEGIN
  UPDATE submission_intents SET status='stale',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE user_id=NEW.user_id AND status IN ('approved','requires_user')
    AND (job_id=NEW.id OR draft_id=NEW.id OR NEW.kind='profile');
END;
CREATE TRIGGER submission_profile_added AFTER INSERT ON records WHEN NEW.kind='profile' BEGIN
  UPDATE submission_intents SET status='stale',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE user_id=NEW.user_id AND status IN ('approved','requires_user');
END;
CREATE TRIGGER submission_profile_removed BEFORE DELETE ON records WHEN OLD.kind='profile' BEGIN
  UPDATE submission_intents SET status='stale',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE user_id=OLD.user_id AND status IN ('approved','requires_user');
END;
