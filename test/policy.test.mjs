// Domain test: policy tools against a real PostgreSQL.
//
// Run with a database URL:
//   ORG_AEOR_KIKX_DATABASE_URL=postgres://... node test/policy.test.mjs
//
// Uses a throwaway actor and deletes every row it created, so the live authority
// model is left exactly as found. Exits non-zero on any failure.
//
// This test exists because of a real silent-failure bug: scope_json::text renders
// JSONB with a space after each colon ({"channel": "probe"}) while
// JSON.stringify produces none ({"channel":"probe"}). A DELETE whose predicate
// compared those two strings matched nothing and reported success, so
// policy_revoke could not remove a scoped grant, and policy_grant's read-back
// threw 'grant did not persist'. Comparison is now JSONB identity:
// scope_json IS NOT DISTINCT FROM $n::jsonb.
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const PLUGIN = new URL('../tools/policy.mjs', import.meta.url);
const A = '__parity_probe_test__';

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

const authorize = async ({ actor, action, scope = {} }) => {
  const grants = await dbHandle.many(
    'SELECT action, scope_json FROM miri_capability WHERE actor = $1 AND action = $2', [ actor, action ]);
  if (!grants.length) return { allowed: false, reason: `no grant for ${action}` };
  for (const g of grants) {
    const required = g.scope_json || null;
    if (!required) return { allowed: true };
    if (Object.entries(required).every(([ k, v ]) => String(scope[k]) === String(v))) return { allowed: true };
  }
  return { allowed: false, reason: 'scope mismatch' };
};

const mod = await import(PLUGIN.href);
const tools = mod.registerTools({ PluginInterface: FakePluginInterface, db: () => dbHandle, authorize });

const out = [];
const ok = (l, c, e = '') => { out.push(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  ' + e : ''}`); return c; };

await dbHandle.query('DELETE FROM miri_capability WHERE actor = $1', [ A ]);

const Grant = tools[ 'miri:policy_grant' ];
const Revoke = tools[ 'miri:policy_revoke' ];
const Can = tools[ 'miri:can' ];
const Who = tools[ 'miri:policy_who' ];

ok('policy_grant is riskLevel high', Grant.riskLevel === 'high');
ok('policy_revoke is riskLevel high', Revoke.riskLevel === 'high');

try {
  await new Grant()._execute({ actor: A, action: 'discord.send', scope: { channel: 'ops' } });
  ok('grant (scoped) succeeds and read-back finds the row', true);
} catch (e) {
  ok('grant (scoped) succeeds and read-back finds the row', false, e.message);
}

ok('can ALLOW for granted scope', (await new Can()._execute({ actor: A, action: 'discord.send', scope: { channel: 'ops' } })).allowed === true);
ok('can DENY for ungranted scope', (await new Can()._execute({ actor: A, action: 'discord.send', scope: { channel: 'other' } })).allowed === false);

await new Grant()._execute({ actor: A, action: 'discord.send', scope: { channel: 'ops' } });
ok('re-grant is idempotent', (await new Who()._execute({ actor: A })).count === 1);

const rev = await new Revoke()._execute({ actor: A, action: 'discord.send', scope: { channel: 'ops' } });
ok('revoke deletes the matching grant', rev.deleted === 1, 'deleted=' + rev.deleted);
ok('can DENY after revoke', (await new Can()._execute({ actor: A, action: 'discord.send', scope: { channel: 'ops' } })).allowed === false);

const rev2 = await new Revoke()._execute({ actor: A, action: 'discord.send', scope: { channel: 'ops' } });
ok('second revoke reports deleted=0 and says so', rev2.deleted === 0 && /nothing was revoked/i.test(rev2.note));

await new Grant()._execute({ actor: A, action: 'system.run' });
ok('unscoped grant allows any scope', (await new Can()._execute({ actor: A, action: 'system.run', scope: { anything: 'x' } })).allowed === true);
ok('revoke unscoped grant deletes 1', (await new Revoke()._execute({ actor: A, action: 'system.run' })).deleted === 1);

await new Grant()._execute({ actor: A, action: 'audio.mute', scope: { host: 'x' } });
ok('NULL revoke does not delete a scoped grant', (await new Revoke()._execute({ actor: A, action: 'audio.mute' })).deleted === 0);

await dbHandle.query('DELETE FROM miri_capability WHERE actor = $1', [ A ]);
ok('cleanup left no residue', (await dbHandle.one('SELECT count(*)::int n FROM miri_capability WHERE actor = $1', [ A ])).n === 0);

console.log(out.join('\n'));
const pass = out.every((l) => l.startsWith('PASS'));
console.log('\nTOTAL:', out.length, '| RESULT:', pass ? 'PASS' : 'FAIL');
await pool.end();
process.exit(pass ? 0 : 1);
