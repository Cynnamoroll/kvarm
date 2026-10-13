-- Guard completeness per branch rule (architecture §0.3, §11.1). `advisory`
-- (the default, today's behavior): an incomplete kvarm/guard verdict (files
-- past the guard's read budgets) is reported but does not block. `required`:
-- publishing into a matching ref refuses an incomplete verdict like a
-- failure (GUARD_INCOMPLETE). Across matching rules `required` wins.
-- Additive only.

ALTER TABLE branch_rules ADD COLUMN guard_completeness TEXT NOT NULL DEFAULT 'advisory'
  CHECK (guard_completeness IN ('advisory', 'required'));
