PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  epoch TEXT NOT NULL,
  recovery_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX credentials_owner ON credentials(user_id);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE INDEX sessions_owner ON sessions(user_id);
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX challenges_expiry ON challenges(expires);
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('profile','job','assessment','draft','interview','run')),
  job_id TEXT,
  fingerprint TEXT,
  data TEXT NOT NULL CHECK(json_valid(data) AND length(CAST(data AS BLOB)) <= 65536),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id,kind,fingerprint)
);
CREATE INDEX records_owner_kind ON records(user_id,kind,created_at DESC);
CREATE INDEX records_owner_job ON records(user_id,job_id);
CREATE TABLE reviews (
  job_id TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('approved','submitted','withdrawn','rejected')),
  draft_id TEXT,
  draft_revision INTEGER,
  destination TEXT,
  confirmation TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX reviews_owner ON reviews(user_id);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  record_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX events_owner_created ON events(user_id,created_at DESC);

CREATE TRIGGER records_insert_quota BEFORE INSERT ON records BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM records WHERE user_id=NEW.user_id) >= 250
    THEN RAISE(ABORT,'workspace record limit') END;
  SELECT CASE WHEN (SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM records WHERE user_id=NEW.user_id) + length(CAST(NEW.data AS BLOB)) > 2097152
    THEN RAISE(ABORT,'workspace storage limit') END;
END;
CREATE TRIGGER records_update_quota BEFORE UPDATE ON records BEGIN
  SELECT CASE WHEN NEW.user_id != OLD.user_id OR NEW.kind != OLD.kind OR NEW.id != OLD.id
    THEN RAISE(ABORT,'immutable record identity') END;
  SELECT CASE WHEN (SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM records WHERE user_id=NEW.user_id AND id != OLD.id) + length(CAST(NEW.data AS BLOB)) > 2097152
    THEN RAISE(ABORT,'workspace storage limit') END;
END;
