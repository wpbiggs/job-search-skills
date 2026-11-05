CREATE TABLE record_versions (
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  saved_at TEXT NOT NULL,
  PRIMARY KEY(record_id, revision)
);
CREATE INDEX versions_owner ON record_versions(user_id,record_id);

DROP TRIGGER records_insert_quota;
DROP TRIGGER records_update_quota;
CREATE TRIGGER records_insert_quota BEFORE INSERT ON records BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM records WHERE user_id=NEW.user_id) >= 250
    THEN RAISE(ABORT,'workspace record limit') END;
  SELECT CASE WHEN (SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM records WHERE user_id=NEW.user_id)
    + (SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM record_versions WHERE user_id=NEW.user_id)
    + length(CAST(NEW.data AS BLOB)) > 2097152 THEN RAISE(ABORT,'workspace storage limit') END;
END;
CREATE TRIGGER records_update_quota BEFORE UPDATE ON records BEGIN
  SELECT CASE WHEN NEW.user_id != OLD.user_id OR NEW.kind != OLD.kind OR NEW.id != OLD.id
    THEN RAISE(ABORT,'immutable record identity') END;
  SELECT CASE WHEN (SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM records WHERE user_id=NEW.user_id)
    + (SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM record_versions WHERE user_id=NEW.user_id)
    + length(CAST(NEW.data AS BLOB)) > 2097152 THEN RAISE(ABORT,'workspace storage limit') END;
END;
CREATE TRIGGER records_version_history AFTER UPDATE OF data ON records WHEN NEW.revision > OLD.revision BEGIN
  INSERT INTO record_versions(record_id,user_id,revision,data,saved_at) VALUES(OLD.id,OLD.user_id,OLD.revision,OLD.data,OLD.updated_at);
END;
-- History is retained until its record or workspace is deleted and counts toward the storage quota.
CREATE TRIGGER challenges_quota BEFORE INSERT ON challenges BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM challenges) >= 10000 THEN RAISE(ABORT,'challenge limit') END;
END;
