ALTER TABLE review_policies ADD COLUMN danger_ack_required INTEGER NOT NULL DEFAULT 0
  CHECK (danger_ack_required IN (0, 1));
