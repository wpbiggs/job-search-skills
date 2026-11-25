CREATE TABLE delegated_intents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  job_revision INTEGER NOT NULL,
  draft_revision INTEGER NOT NULL,
  profile_revision INTEGER NOT NULL,
  destination TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  form TEXT NOT NULL CHECK(json_valid(form) AND length(CAST(form AS BLOB))<=20000),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=65536),
  nonce_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('approved','running','committing','needs_user','fixture_verified','uncertain','failed','cancelled','expired','stale')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX delegated_owner ON delegated_intents(user_id,created_at DESC);
CREATE UNIQUE INDEX delegated_active ON delegated_intents(user_id,job_id) WHERE status IN ('approved','running','committing','uncertain');
CREATE TABLE delegated_attempts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES delegated_intents(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  receipt TEXT CHECK(receipt IS NULL OR (json_valid(receipt) AND length(receipt)<=2000))
);
CREATE TABLE executor_controls (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1))
);
CREATE TABLE executor_budget (day TEXT PRIMARY KEY,used INTEGER NOT NULL CHECK(used BETWEEN 1 AND 10));
CREATE TABLE executor_browser_leases (id TEXT PRIMARY KEY,expires_at TEXT NOT NULL);
CREATE TRIGGER delegated_quota BEFORE INSERT ON delegated_intents BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM delegated_intents WHERE user_id=NEW.user_id)>=50
    OR (SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) FROM delegated_intents WHERE user_id=NEW.user_id)+length(CAST(NEW.payload AS BLOB))>1048576
    THEN RAISE(ABORT,'delegated storage limit') END;
END;
CREATE TRIGGER delegated_changed AFTER UPDATE ON records BEGIN
  UPDATE delegated_intents SET status='stale',reason='Saved application content changed.',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE user_id=NEW.user_id AND status IN ('approved','running') AND (job_id=NEW.id OR draft_id=NEW.id OR NEW.kind='profile');
END;
CREATE TRIGGER delegated_profile_removed BEFORE DELETE ON records WHEN OLD.kind='profile' BEGIN
  UPDATE delegated_intents SET status='stale',reason='Profile removed.',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE user_id=OLD.user_id AND status IN ('approved','running');
END;
CREATE TRIGGER delegated_profile_added AFTER INSERT ON records WHEN NEW.kind='profile' BEGIN
  UPDATE delegated_intents SET status='stale',reason='Profile replaced.',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE user_id=NEW.user_id AND status IN ('approved','running');
END;
