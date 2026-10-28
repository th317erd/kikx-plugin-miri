-- The acting character a Miri bot speaks from.
-- Replaces the hardcoded guidance string the plugin returned in Phase 1.
CREATE TABLE IF NOT EXISTS miri_actor_character (
  actor        TEXT        PRIMARY KEY,
  character    TEXT        NOT NULL,
  compressed   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
