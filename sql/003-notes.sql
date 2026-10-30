-- Notes: actor-partitioned free text with tags.
--
-- Miri's /notes/* defaults to the calling actor and allows actor:"*" for teamwork.
-- Notes grant no authority; they are content, not capability.
--
-- version supports optimistic concurrency: /notes/update and /notes/delete both
-- require expectedVersion, and a stale value is a conflict rather than a silent
-- overwrite. Incremented by hand in the UPDATE statement rather than by a trigger,
-- so the increment is visible in the statement that changes the row.
CREATE TABLE IF NOT EXISTS miri_note (
  id          BIGSERIAL    PRIMARY KEY,
  actor       TEXT         NOT NULL,
  title       TEXT         NOT NULL,
  body        TEXT         NOT NULL DEFAULT '',
  tags        TEXT[]       NOT NULL DEFAULT '{}',
  version     INTEGER      NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Listing is newest-first per actor.
CREATE INDEX IF NOT EXISTS miri_note_actor_created
  ON miri_note (actor, created_at DESC);

-- Tag filtering.
CREATE INDEX IF NOT EXISTS miri_note_tags
  ON miri_note USING GIN (tags);

-- Trigram search over title and body.
--
-- pg_trgm is installed in this database (verified 2026-10-30: version 1.6, PG 17.11).
-- unaccent and fuzzystrmatch are NOT installed, which is why the tool refuses
-- phonetic search outright instead of silently downgrading it to substring.
--
-- The body index is deliberately included: Miri searches title+body, and a seq scan
-- over large bodies would be the real cost. It is the larger of the two indexes;
-- if note volume ever makes it a problem, the honest fix is to drop it and say so,
-- not to quietly stop searching bodies.
CREATE INDEX IF NOT EXISTS miri_note_title_trgm
  ON miri_note USING GIN (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS miri_note_body_trgm
  ON miri_note USING GIN (body gin_trgm_ops);
