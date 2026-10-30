'use strict';

// Domain: notes.
// Miri routes covered: /notes/add, /notes/get, /notes/list, /notes/search,
// /notes/update, /notes/delete. Six of six.
//
// Notes are actor-partitioned content. They grant no authority, and nothing in
// here consults authorize(): reading or writing your own notes is not a privileged
// action. Cross-actor reads require actor:"*" or an explicit actor, matching Miri.
//
// SEARCH HONESTY
// Miri's /notes/search offers auto | substring | trigram | phonetic. This database
// has pg_trgm 1.6 but NOT fuzzystrmatch or unaccent (verified 2026-10-30), so
// phonetic is impossible without a schema change. This tool therefore refuses
// `phonetic` with a clear error instead of quietly returning substring results and
// letting the caller believe phonetic matching happened.
//
// OPTIMISTIC CONCURRENCY
// update and delete require expectedVersion. A stale version is a conflict, not an
// overwrite. This is Miri's behaviour and the reason /todo complete is trustworthy;
// losing it would be a silent downgrade.

export function registerTools({ PluginInterface, db }) {
  const MAX_TITLE = 512;
  const MAX_BODY = 1048576;
  const MAX_TAGS = 64;
  const CALLING_ACTOR = 'miri';

  const actorOf = (params) => (params.actor && String(params.actor).trim()) || CALLING_ACTOR;

  const normaliseTags = (tags) => {
    if (tags === undefined || tags === null) return undefined;
    if (!Array.isArray(tags)) throw new Error('tags must be an array of strings');
    if (tags.length > MAX_TAGS) throw new Error(`at most ${MAX_TAGS} tags`);
    let out = tags.map((t) => String(t).trim()).filter(Boolean);
    // De-duplicate so a tag list cannot quietly double a row's tag count.
    return [ ...new Set(out) ];
  };

  const noteRow = (r, { withBody = true } = {}) => ({
    ID: String(r.id),
    actor: r.actor,
    title: r.title,
    ...(withBody ? { body: r.body } : {}),
    tags: r.tags,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  class NoteAddTool extends PluginInterface {
    static pluginID = 'miri';
    static featureName = 'notes_add';
    static displayName = 'Add a note';
    static description = 'Create a note for an actor. Requires a title; body and tags are optional.';
    static version = '0.1.0';
    static riskLevel = 'low';
    static inputSchema = {
      type: 'object',
      required: [ 'title' ],
      properties: {
        actor: { type: 'string', description: 'Note owner; defaults to the calling actor' },
        title: { type: 'string', minLength: 1, maxLength: MAX_TITLE },
        body: { type: 'string', maxLength: MAX_BODY },
        tags: { type: 'array', items: { type: 'string' }, maxItems: MAX_TAGS },
      },
    };

    async _execute(params = {}) {
      let title = (params.title || '').trim();
      if (!title) throw new Error('notes_add requires a non-empty title');
      if (title.length > MAX_TITLE) throw new Error(`title exceeds ${MAX_TITLE} characters`);
      let body = params.body == null ? '' : String(params.body);
      if (body.length > MAX_BODY) throw new Error(`body exceeds ${MAX_BODY} characters`);

      let row = await db().one(
        `INSERT INTO miri_note (actor, title, body, tags)
         VALUES ($1, $2, $3, $4::text[])
         RETURNING id, actor, title, body, tags, version, created_at, updated_at`,
        [ actorOf(params), title, body, normaliseTags(params.tags) ?? [] ],
      );
      // Return the persisted row, not the input, so a caller cannot mistake a
      // failed normalisation for a successful write.
      return { created: true, note: noteRow(row) };
    }
  }

  class NoteGetTool extends PluginInterface {
    static pluginID = 'miri';
    static featureName = 'notes_get';
    static displayName = 'Get a note';
    static description = 'Read one note by ID. Supports titlesOnly and metaOnly to avoid returning a large body.';
    static version = '0.1.0';
    static riskLevel = 'none';
    static inputSchema = {
      type: 'object',
      required: [ 'ID' ],
      properties: {
        ID: { type: 'string', pattern: '^[0-9]+$' },
        titlesOnly: { type: 'boolean' },
        metaOnly: { type: 'boolean' },
      },
    };

    async _execute(params = {}) {
      if (!/^[0-9]+$/.test(String(params.ID || ''))) throw new Error('notes_get requires a numeric ID');
      let metaOnly = params.metaOnly === true || params.titlesOnly === true;
      let row = await db().one(
        `SELECT id, actor, title,
                ${metaOnly ? "'[omitted]'::text" : 'body'} AS body,
                tags, version, created_at, updated_at
           FROM miri_note WHERE id = $1::bigint`,
        [ params.ID ],
      );
      if (!row) throw new Error(`no note with ID ${params.ID}`);
      let note = noteRow(row);
      // Say the body was withheld rather than returning an empty string, which
      // would be indistinguishable from a note that genuinely has no body.
      if (metaOnly) note.bodyOmitted = true;
      return { note };
    }
  }

  class NoteListTool extends PluginInterface {
    static pluginID = 'miri';
    static featureName = 'notes_list';
    static displayName = 'List notes';
    static description = 'List notes newest-first. Defaults to the calling actor; pass actor "*" for all actors. Filter by tags.';
    static version = '0.1.0';
    static riskLevel = 'none';
    static inputSchema = {
      type: 'object',
      properties: {
        actor: { type: 'string', description: 'Actor label, or "*" for all actors' },
        tags: { type: 'array', items: { type: 'string' }, maxItems: MAX_TAGS },
        titlesOnly: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        offset: { type: 'integer', minimum: 0 },
      },
    };

    async _execute(params = {}) {
      let actor = params.actor === '*' ? null : actorOf(params);
      let limit = Math.min(Math.max(Number(params.limit) || 100, 1), 200);
      let offset = Math.max(Number(params.offset) || 0, 0);
      let tags = normaliseTags(params.tags) ?? null;

      let rows = await db().many(
        `SELECT id, actor, title,
                ${params.titlesOnly === true ? "'[omitted]'::text" : 'body'} AS body,
                tags, version, created_at, updated_at
           FROM miri_note
          WHERE ($1::text IS NULL OR actor = $1)
            AND ($2::text[] IS NULL OR tags && $2::text[])
          ORDER BY created_at DESC, id DESC
          LIMIT $3 OFFSET $4`,
        [ actor, tags, limit, offset ],
      );
      return {
        notes: rows.map((r) => noteRow(r)),
        scope: actor === null ? '*' : actor,
        limit,
        offset,
        returned: rows.length,
        ...(params.titlesOnly === true ? { bodiesOmitted: true } : {}),
      };
    }
  }

  class NoteSearchTool extends PluginInterface {
    static pluginID = 'miri';
    static featureName = 'notes_search';
    static displayName = 'Search notes';
    static description = 'Search note title and body. Modes: substring, trigram (similarity-ranked). Phonetic is refused because fuzzystrmatch is not installed.';
    static version = '0.1.0';
    static riskLevel = 'none';
    static inputSchema = {
      type: 'object',
      required: [ 'query' ],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 512 },
        mode: { type: 'string', enum: [ 'substring', 'trigram', 'phonetic' ] },
        actor: { type: 'string', description: 'Actor label, or "*" for all actors. Defaults to all.' },
        tags: { type: 'array', items: { type: 'string' }, maxItems: MAX_TAGS },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    };

    async _execute(params = {}) {
      let q = (params.query || '').trim();
      if (!q) throw new Error('notes_search requires a non-empty query');
      let mode = params.mode || 'substring';
      if (mode === 'phonetic')
        throw new Error(
          'phonetic search is unavailable: fuzzystrmatch and unaccent are not installed in this database. ' +
          'Use substring or trigram. Refusing rather than returning non-phonetic results under a phonetic label.',
        );
      if (mode !== 'substring' && mode !== 'trigram')
        throw new Error(`unknown mode "${mode}"; expected substring, trigram, or phonetic`);

      let limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
      let actor = params.actor === '*' ? null : (params.actor ? String(params.actor) : null);
      let tags = normaliseTags(params.tags) ?? null;

      // trigram uses the GIN indexes; substring uses ILIKE and will not. Both are
      // reported honestly in `mode` so a caller can tell which they got.
      let rows;
      if (mode === 'trigram') {
        rows = await db().many(
          `SELECT id, actor, title,
                  ts_headline('simple', body, plainto_tsquery('simple', $5),
                    'StartSel=«,StopSel=»,MaxFragments=1,MaxWords=25') AS snippet,
                  tags, version, created_at, updated_at,
                  greatest(similarity(title, $5), similarity(body, $5)) AS score
             FROM miri_note
            WHERE (title % $5 OR body % $5 OR title ILIKE '%' || $5 || '%' OR body ILIKE '%' || $5 || '%')
              AND ($1::text IS NULL OR actor = $1)
              AND ($2::text[] IS NULL OR tags && $2::text[])
            ORDER BY score DESC, id DESC
            LIMIT $3 OFFSET $4`,
          [ actor, tags, limit, 0, q ],
        );
      } else {
        rows = await db().many(
          `SELECT id, actor, title, body AS snippet, tags, version, created_at, updated_at,
                  NULL::real AS score
             FROM miri_note
            WHERE (title ILIKE '%' || $5 || '%' OR body ILIKE '%' || $5 || '%')
              AND ($1::text IS NULL OR actor = $1)
              AND ($2::text[] IS NULL OR tags && $2::text[])
            ORDER BY created_at DESC, id DESC
            LIMIT $3 OFFSET $4`,
          [ actor, tags, limit, 0, q ],
        );
      }

      return {
        query: q,
        mode,
        scope: actor === null ? '*' : actor,
        hits: rows.map((r) => ({
          ID: String(r.id),
          actor: r.actor,
          title: r.title,
          snippet: r.snippet,
          score: r.score === null ? null : Number(r.score),
          version: r.version,
          createdAt: r.created_at,
        })),
        returned: rows.length,
        limit,
        // State the ranking truth rather than implying equal relevance ordering.
        ranking: mode === 'trigram'
          ? 'similarity-ranked (greatest of title and body)'
          : 'recency-ordered; substring mode does not rank by relevance',
      };
    }
  }

  class NoteUpdateTool extends PluginInterface {
    static pluginID = 'miri';
    static featureName = 'notes_update';
    static displayName = 'Update a note';
    static description = 'Revise a note. Requires expectedVersion; a stale version is a conflict, not an overwrite. Supply at least one of title, body, tags.';
    static version = '0.1.0';
    static riskLevel = 'low';
    static inputSchema = {
      type: 'object',
      required: [ 'ID', 'expectedVersion' ],
      properties: {
        ID: { type: 'string', pattern: '^[0-9]+$' },
        expectedVersion: { type: 'integer', minimum: 1 },
        title: { type: 'string', minLength: 1, maxLength: MAX_TITLE },
        body: { type: 'string', maxLength: MAX_BODY },
        tags: { type: 'array', items: { type: 'string' }, maxItems: MAX_TAGS },
      },
    };

    async _execute(params = {}) {
      if (!/^[0-9]+$/.test(String(params.ID || ''))) throw new Error('notes_update requires a numeric ID');
      let expected = Number(params.expectedVersion);
      if (!Number.isInteger(expected) || expected < 1)
        throw new Error('notes_update requires an integer expectedVersion >= 1');

      let sets = [];
      let values = [];
      let i = 1;

      if (params.title !== undefined) {
        let t = (params.title || '').trim();
        if (!t) throw new Error('title cannot be empty');
        sets.push(`title = $${i++}`);
        values.push(t);
      }
      if (params.body !== undefined) {
        let b = params.body == null ? '' : String(params.body);
        if (b.length > MAX_BODY) throw new Error(`body exceeds ${MAX_BODY} characters`);
        sets.push(`body = $${i++}`);
        values.push(b);
      }
      if (params.tags !== undefined) {
        sets.push(`tags = $${i++}::text[]`);
        values.push(normaliseTags(params.tags));
      }
      if (!sets.length)
        throw new Error('notes_update requires at least one of title, body, tags');

      // version increments in the same statement, so the concurrency check and the
      // write cannot be separated by an interleaved writer.
      let row = await db().one(
        `UPDATE miri_note
            SET ${sets.join(', ')},
                version = version + 1,
                updated_at = now()
          WHERE id = $${i++}::bigint AND version = $${i++}
          RETURNING id, actor, title, body, tags, version, created_at, updated_at`,
        [ ...values, params.ID, expected ],
      );

      if (!row) {
        // Distinguish "no such note" from "conflict", because they need different
        // responses and both previously looked like a generic failure.
        let existing = await db().one('SELECT version FROM miri_note WHERE id = $1::bigint', [ params.ID ]);
        if (!existing) throw new Error(`no note with ID ${params.ID}`);
        throw new Error(
          `version conflict: note ${params.ID} is at version ${existing.version}, expected ${expected}. ` +
          'Re-read the note and retry with the current version.',
        );
      }
      return { updated: true, note: noteRow(row) };
    }
  }

  class NoteDeleteTool extends PluginInterface {
    static pluginID = 'miri';
    static featureName = 'notes_delete';
    static displayName = 'Delete a note';
    static description = 'Delete a note using its current version. A stale version is a conflict and nothing is deleted.';
    static version = '0.1.0';
    static riskLevel = 'high';
    static inputSchema = {
      type: 'object',
      required: [ 'ID', 'expectedVersion' ],
      properties: {
        ID: { type: 'string', pattern: '^[0-9]+$' },
        expectedVersion: { type: 'integer', minimum: 1 },
      },
    };

    async _execute(params = {}) {
      if (!/^[0-9]+$/.test(String(params.ID || ''))) throw new Error('notes_delete requires a numeric ID');
      let expected = Number(params.expectedVersion);
      if (!Number.isInteger(expected) || expected < 1)
        throw new Error('notes_delete requires an integer expectedVersion >= 1');

      let result = await db().query(
        'DELETE FROM miri_note WHERE id = $1::bigint AND version = $2',
        [ params.ID, expected ],
      );
      let deleted = result?.rowCount ?? 0;
      if (deleted === 0) {
        let existing = await db().one('SELECT version FROM miri_note WHERE id = $1::bigint', [ params.ID ]);
        if (!existing) throw new Error(`no note with ID ${params.ID}`);
        throw new Error(
          `version conflict: note ${params.ID} is at version ${existing.version}, expected ${expected}. Nothing was deleted.`,
        );
      }
      return { deleted: 1, ID: String(params.ID) };
    }
  }

  return {
    'miri:notes_add': NoteAddTool,
    'miri:notes_get': NoteGetTool,
    'miri:notes_list': NoteListTool,
    'miri:notes_search': NoteSearchTool,
    'miri:notes_update': NoteUpdateTool,
    'miri:notes_delete': NoteDeleteTool,
  };
}
