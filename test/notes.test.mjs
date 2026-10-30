'use strict';

// Domain test: notes tools against a real PostgreSQL.
//
// Run with a database URL:
//   ORG_AEOR_KIKX_DATABASE_URL=postgres://... node test/notes.test.mjs
//
// Uses a throwaway actor and deletes every row it created, so real notes are left
// exactly as found. Exits non-zero on any failure.
//
// This test exists because the notes domain was written but never exercised. The
// behaviours worth guarding are the ones where a silent downgrade would look like
// success: optimistic concurrency (expectedVersion), the refusal of phonetic
// search, and the distinction between "no such note" and "version conflict".
import pg from 'pg';

const PLUGIN = new URL('../tools/notes.mjs', import.meta.url);
const A = '__notes_probe_test__';

if (!process.env.ORG_AEOR_KIKX_DATABASE_URL) {
  console.error('ORG_AEOR_KIKX_DATABASE_URL is required');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.ORG_AEOR_KIKX_DATABASE_URL, max: 2 });
const dbHandle = {
  async query(sql, params = []) { return await pool.query(sql, params); },
  async one(sql, params = []) { const r = await pool.query(sql, params); return r.rows[0] ?? null; },
  async many(sql, params = []) { const r = await pool.query(sql, params); return r.rows; },
};

class FakePluginInterface {
  static pluginID = 'unknown'; static featureName = 'unknown';
  static riskLevel = 'high'; static inputSchema = null;
}

const mod = await import(PLUGIN.href);
const tools = mod.registerTools({ PluginInterface: FakePluginInterface, db: () => dbHandle });

const out = [];
const ok = (label, cond, extra = '') => {
  out.push(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  return cond;
};

const Add = tools['miri:notes_add'];
const Get = tools['miri:notes_get'];
const List = tools['miri:notes_list'];
const Search = tools['miri:notes_search'];
const Update = tools['miri:notes_update'];
const Delete = tools['miri:notes_delete'];

ok('six notes tools are exported', [Add, Get, List, Search, Update, Delete].every(Boolean));
ok('notes_delete is riskLevel high', Delete.riskLevel === 'high');
ok('notes_add is riskLevel low', Add.riskLevel === 'low');

await dbHandle.query('DELETE FROM miri_note WHERE actor = $1', [A]);

// --- create + read ---------------------------------------------------------

let created = await new Add()._execute({
  actor: A,
  title: 'Parity mission',
  body: 'Miri framework parity in Kikx; notes are actor-partitioned.',
  tags: [ 'kikx', 'parity', 'kikx' ],
});
ok('add returns the persisted row', created.created === true && created.note.title === 'Parity mission');
ok('add de-duplicates tags', JSON.stringify(created.note.tags) === JSON.stringify([ 'kikx', 'parity' ]), JSON.stringify(created.note.tags));
ok('add starts at version 1', created.note.version === 1);

const noteID = created.note.ID;
ok('add assigns a numeric ID', /^[0-9]+$/.test(noteID), noteID);

let fetched = await new Get()._execute({ ID: noteID });
ok('get returns the body by default', fetched.note.body.includes('actor-partitioned'));

let meta = await new Get()._execute({ ID: noteID, metaOnly: true });
ok('get metaOnly omits the body and says so', meta.note.bodyOmitted === true && meta.note.body === '[omitted]');

let missing = null;
try { await new Get()._execute({ ID: '999999999' }); } catch (e) { missing = e.message; }
ok('get on a missing ID throws a clear error', /no note with ID/i.test(missing || ''), missing || 'no error');

// --- update + optimistic concurrency ---------------------------------------

let updated = await new Update()._execute({ ID: noteID, expectedVersion: 1, title: 'Parity mission (revised)' });
ok('update bumps the version', updated.updated === true && updated.note.version === 2);

let conflict = null;
try { await new Update()._execute({ ID: noteID, expectedVersion: 1, title: 'stale write' }); } catch (e) { conflict = e.message; }
ok('a stale version is a conflict, not an overwrite', /version conflict/i.test(conflict || ''), conflict || 'no error');

let noFields = null;
try { await new Update()._execute({ ID: noteID, expectedVersion: 2 }); } catch (e) { noFields = e.message; }
ok('update with no fields is refused', /at least one of/i.test(noFields || ''), noFields || 'no error');

// --- search ----------------------------------------------------------------

let sub = await new Search()._execute({ query: 'partitioned', actor: A });
ok('substring search finds the note', sub.returned === 1, `returned=${sub.returned}`);
ok('substring search admits it is recency-ordered', /recency/i.test(sub.ranking), sub.ranking);

let tri = await new Search()._execute({ query: 'partitioned', mode: 'trigram', actor: A });
ok('trigram search finds the note', tri.returned === 1, `returned=${tri.returned}`);
ok('trigram search reports similarity ranking', /similarity/i.test(tri.ranking), tri.ranking);

let phonetic = null;
try { await new Search()._execute({ query: 'partitiond', mode: 'phonetic', actor: A }); } catch (e) { phonetic = e.message; }
ok(
  'phonetic search is refused rather than silently downgraded',
  /phonetic search is unavailable/i.test(phonetic || ''),
  phonetic || 'no error',
);

// --- list ------------------------------------------------------------------

let listed = await new List()._execute({ actor: A });
ok('list returns the actor\'s notes', listed.returned === 1 && listed.scope === A);
ok('list reports its own paging', listed.limit === 100 && listed.offset === 0);

let tagsOnly = await new List()._execute({ actor: A, tags: [ 'parity' ] });
ok('list filters by tag', tagsOnly.returned === 1);

let wrongTag = await new List()._execute({ actor: A, tags: [ 'no-such-tag' ] });
ok('list filters by a tag that matches nothing', wrongTag.returned === 0);

let titles = await new List()._execute({ actor: A, titlesOnly: true });
ok('titlesOnly omits bodies and says so', titles.bodiesOmitted === true && titles.notes[0].body === '[omitted]');

// --- delete ----------------------------------------------------------------

let staleDelete = null;
try { await new Delete()._execute({ ID: noteID, expectedVersion: 1 }); } catch (e) { staleDelete = e.message; }
ok('delete with a stale version deletes nothing', /version conflict/i.test(staleDelete || ''), staleDelete || 'no error');
ok('the note survives a refused delete', (await new Get()._execute({ ID: noteID })).note.version === 2);

let removed = await new Delete()._execute({ ID: noteID, expectedVersion: 2 });
ok('delete removes the note at its current version', removed.deleted === 1);

let gone = null;
try { await new Get()._execute({ ID: noteID }); } catch (e) { gone = e.message; }
ok('the note is really gone', /no note with ID/i.test(gone || ''));

// --- validation ------------------------------------------------------------

let noTitle = null;
try { await new Add()._execute({ actor: A, title: '   ' }); } catch (e) { noTitle = e.message; }
ok('add refuses an empty title', /non-empty title/i.test(noTitle || ''), noTitle || 'no error');

let badTags = null;
try { await new Add()._execute({ actor: A, title: 'x', tags: 'not-an-array' }); } catch (e) { badTags = e.message; }
ok('add refuses non-array tags', /must be an array/i.test(badTags || ''), badTags || 'no error');

await dbHandle.query('DELETE FROM miri_note WHERE actor = $1', [A]);
let residue = await dbHandle.one('SELECT count(*)::int n FROM miri_note WHERE actor = $1', [A]);
ok('cleanup left no residue', residue.n === 0, `n=${residue.n}`);

console.log(out.join('\n'));
const pass = out.every((l) => l.startsWith('PASS'));
console.log('\nTOTAL:', out.length, '| RESULT:', pass ? 'PASS' : 'FAIL');
await pool.end();
process.exit(pass ? 0 : 1);
