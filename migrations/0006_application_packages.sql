CREATE TABLE application_packages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  job_revision INTEGER NOT NULL,
  profile_revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  package TEXT NOT NULL CHECK(json_valid(package) AND length(CAST(package AS BLOB))<=65536),
  status TEXT NOT NULL CHECK(status IN ('approved','stale','expired','cancelled')),
  approved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE application_package_documents (
  package_id TEXT NOT NULL REFERENCES application_packages(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  draft_revision INTEGER NOT NULL,
  PRIMARY KEY(package_id,draft_id)
);
CREATE INDEX application_packages_owner ON application_packages(user_id,approved_at DESC);
CREATE UNIQUE INDEX application_packages_active ON application_packages(user_id,job_id) WHERE status='approved';
CREATE TRIGGER application_packages_quota BEFORE INSERT ON application_packages BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM application_packages WHERE user_id=NEW.user_id)>=50
    OR (SELECT coalesce(sum(length(CAST(package AS BLOB))),0) FROM application_packages WHERE user_id=NEW.user_id)+length(CAST(NEW.package AS BLOB))>1048576
    THEN RAISE(ABORT,'application package storage limit') END;
END;
CREATE TRIGGER application_packages_changed AFTER UPDATE ON records BEGIN
  UPDATE application_packages SET status='stale',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=NEW.user_id AND status='approved'
    AND (job_id=NEW.id OR profile_id=NEW.id OR NEW.kind='profile' OR id IN (SELECT package_id FROM application_package_documents WHERE draft_id=NEW.id));
END;
CREATE TRIGGER application_packages_profile_added AFTER INSERT ON records WHEN NEW.kind='profile' BEGIN
  UPDATE application_packages SET status='stale',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=NEW.user_id AND status='approved';
END;
CREATE TRIGGER application_packages_document_removed BEFORE DELETE ON records BEGIN
  DELETE FROM application_packages WHERE id IN (SELECT package_id FROM application_package_documents WHERE draft_id=OLD.id);
END;
