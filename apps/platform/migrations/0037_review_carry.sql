CREATE TABLE change_review_files (
  review_id TEXT NOT NULL REFERENCES change_reviews(id),
  path TEXT NOT NULL,
  old_path TEXT,
  old_hash TEXT,
  new_hash TEXT,
  PRIMARY KEY (review_id, path)
);
ALTER TABLE change_reviews ADD COLUMN carried_from_head TEXT;
ALTER TABLE change_reviews ADD COLUMN carried_from_review TEXT;
