-- Signed-out browser sessions (architecture §11.1). Session cookies are
-- sealed and stateless, so sign-out records the session's id here until the
-- cookie's own absolute expiry; a copied cookie then stops working at once.
-- Additive only.

CREATE TABLE session_revocations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_session_revocations_expiry ON session_revocations(expires_at);
