-- Who may do what, where. Deny by default: a grant must exist and match.
-- scope_json narrows a grant; NULL means "no narrowing", never "everything".
--
-- A PRIMARY KEY cannot contain an expression in PostgreSQL, so the NULL-tolerant
-- uniqueness lives in a unique index instead.
CREATE TABLE IF NOT EXISTS miri_capability (
  actor      TEXT        NOT NULL,
  action     TEXT        NOT NULL,
  scope_json JSONB       NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by TEXT        NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS miri_capability_unique
  ON miri_capability (actor, action, COALESCE(scope_json::text, ''));
