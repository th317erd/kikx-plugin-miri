'use strict';

// Domain: policy and authority.
// Miri routes covered: /policy/can, /policy/actors, /policy/roles, /policy/who.
//
// This is the highest-value domain in the plugin, because every privileged tool
// (system_run, audio_mute, any transport send) is supposed to ask it first. The
// framework's /policy/* is read-only "inspect before it gates anything". This
// module adds the write side (grant/revoke) that makes the read side meaningful,
// because miri_capability is the single source of truth for authorize().
//
// Deny by default. A grant must exist, match the action exactly, and match every
// key in the request's scope. No grant means no.
//
// ---------------------------------------------------------------------------
// SCOPE COMPARISON — read this before changing any predicate here.
//
// `scope_json::text` is NOT the JSON you passed in. PostgreSQL renders JSONB with
// a space after each colon:
//
//     JSON.stringify({channel:'probe'})  ->  {"channel":"probe"}    len 19
//     scope_json::text                   ->  {"channel": "probe"}   len 20
//
// So `COALESCE(scope_json::text,'') = COALESCE($3,'')` never matches, and a
// DELETE built on it silently removes nothing while reporting success. That was a
// real bug in this file, proven against the live database: the predicate returned
// rowCount=0 for a grant it had just written.
//
// Comparison is therefore by JSONB identity — `scope_json IS NOT DISTINCT FROM
// $2::jsonb` — which is format-insensitive and NULL-safe in one operator.
// The COALESCE(...::text) form is kept ONLY inside the ON CONFLICT target, where
// it must textually match the unique index expression, and for GROUP BY keys.
// ---------------------------------------------------------------------------

export function registerTools({ PluginInterface, db, authorize }) {
  // Capabilities are `<domain>.<verb>` or `<domain>.<verb>.<scope>`.
  // Kept narrow on purpose: an over-broad pattern would let a typo grant a world.
  const ACTION_PATTERN = '^[a-z][a-z0-9_-]*(\\.[a-z0-9_-]+){1,4}$';

  const scopeText = (scope) => (scope === null || scope === undefined ? null : JSON.stringify(scope));

  class CanTool extends PluginInterface {
    static pluginID = 'miri';
    static featureName = 'can';
    static displayName = 'Check capability';
    static description = 'Ask whether an actor may perform an action in a scope. Deny by default. Changes nothing.';
    static version = '0.1.0';
    static riskLevel = 'none';
    static inputSchema = {
      type: 'object',
      required: [ 'actor', 'action' ],
      properties: {
        actor: { type: 'string' },
        action: { type: 'string', pattern: ACTION_PATTERN },
        scope: { type: 'object', description: 'Key/value scope the grant must match' },
      },
    };

    async _execute(params = {}) {
      return authorize({ actor: params.actor, action: params.action, scope: params.scope || {} });
    }
  }

  class ActorsTool extends PluginInterface {
    static pluginID = 'miri';
    static featureName = 'policy_actors';
    static displayName = 'List policy actors';
    static description = 'List every actor that appears in the authority model, with its grant count and most recent grant.';
    static version = '0.1.0';
    static riskLevel = 'none';
    static inputSchema = { type: 'object', properties: {} };

    async _execute() {
      let rows = await db().many(
        `SELECT actor,
                count(*)             AS grants,
                max(granted_at)      AS last_granted,
                array_agg(DISTINCT action ORDER BY action) AS actions
           FROM miri_capability
          GROUP BY actor
          ORDER BY actor`,
      );
      // An actor that has no grants is invisible here by construction. That is a
      // real limitation, not a bug to paper over: the table records only grants.
      return {
        actors: rows.map((r) => ({
          actor: r.actor,
          grants: Number(r.grants),
          lastGranted: r.last_granted,
          actions: r.actions,
        })),
        returned: rows.length,
        note: 'Actors with zero grants do not appear; miri_capability stores grants only.',
      };
    }
  }

  class RolesTool extends PluginInterface {
    static pluginID = 'miri';
    static featureName = 'policy_roles';
    static displayName = 'List policy roles';
    static description = 'Group actors by action so the effective role shape is visible. Miri has no role table; roles are derived from grants.';
    static version = '0.1.0';
    static riskLevel = 'none';
    static inputSchema = { type: 'object', properties: {} };

    async _execute() {
      let rows = await db().many(
        `SELECT action, array_agg(actor ORDER BY actor) AS actors, count(*) AS grants
           FROM miri_capability
          GROUP BY action
          ORDER BY action`,
      );
      return {
        roles: rows.map((r) => ({
          action: r.action,
          actors: r.actors,
          grants: Number(r.grants),
        })),
        returned: rows.length,
        note: 'Derived from grants. Miri has no explicit ROLE table, and this does not invent one.',
      };
    }
  }

  class WhoTool extends PluginInterface {
    static pluginID = 'miri';
    static featureName = 'policy_who';
    static displayName = 'Inspect one actor';
    static description = 'Everything recorded about one actor: every grant, its scope, and when and by whom it was granted.';
    static version = '0.1.0';
    static riskLevel = 'none';
    static inputSchema = {
      type: 'object',
      required: [ 'actor' ],
      properties: {
        actor: { type: 'string', minLength: 1, maxLength: 64 },
      },
    };

    async _execute(params = {}) {
      if (!params.actor) throw new Error('policy_who requires actor');
      let rows = await db().many(
        `SELECT actor, action, scope_json, granted_at, granted_by
           FROM miri_capability
          WHERE actor = $1
          ORDER BY action, granted_at`,
        [ params.actor ],
      );
      return {
        actor: params.actor,
        grants: rows.map((r) => ({
          action: r.action,
          scope: r.scope_json,
          grantedAt: r.granted_at,
          grantedBy: r.granted_by,
        })),
        count: rows.length,
        // Stated plainly so a caller cannot read an empty list as a refusal of
        // something specific: it means no grant exists at all.
        interpretation: rows.length
          ? 'Any action not listed here is denied.'
          : 'No grants. This actor is denied everything.',
      };
    }
  }

  class GrantTool extends PluginInterface {
    static pluginID = 'miri';
    static featureName = 'policy_grant';
    static displayName = 'Grant a capability';
    static description = 'Grant an actor permission for one action in one scope. Idempotent for the same (actor, action, scope). This is authority: it changes what other tools are allowed to do.';
    static version = '0.1.0';
    // It writes the authority model itself. Highest risk in the plugin.
    static riskLevel = 'high';
    static inputSchema = {
      type: 'object',
      required: [ 'actor', 'action' ],
      properties: {
        actor: { type: 'string', minLength: 1, maxLength: 64 },
        action: { type: 'string', pattern: ACTION_PATTERN },
        scope: { type: [ 'object', 'null' ], description: 'Key/value scope; null means no narrowing' },
        grantedBy: { type: 'string', description: 'Who is asserting the grant; a label, not authentication' },
      },
    };

    async _execute(params = {}) {
      let { actor, action } = params;
      if (!actor || !action) throw new Error('policy_grant requires actor and action');
      let scope = params.scope === undefined ? null : params.scope;

      // ON CONFLICT target must textually match the unique index expression.
      await db().query(
        `INSERT INTO miri_capability (actor, action, scope_json, granted_by)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (actor, action, COALESCE(scope_json::text, '')) DO UPDATE
           SET granted_at = now(), granted_by = EXCLUDED.granted_by`,
        [ actor, action, scopeText(scope), params.grantedBy || 'miri' ],
      );

      // Read it back rather than reporting the input, using JSONB identity so the
      // comparison is not defeated by JSONB's own formatting.
      let row = await db().one(
        `SELECT actor, action, scope_json, granted_at
           FROM miri_capability
          WHERE actor = $1 AND action = $2
            AND scope_json IS NOT DISTINCT FROM $3::jsonb`,
        [ actor, action, scopeText(scope) ],
      );
      if (!row) throw new Error('grant did not persist; no row found on read-back');
      return {
        granted: true,
        actor: row.actor,
        action: row.action,
        scope: row.scope_json,
        grantedAt: row.granted_at,
      };
    }
  }

  class RevokeTool extends PluginInterface {
    static pluginID = 'miri';
    static featureName = 'policy_revoke';
    static displayName = 'Revoke a capability';
    static description = 'Remove one grant for an actor/action/scope. Reports whether a row was actually deleted — a revoke that matched nothing says so instead of claiming success.';
    static version = '0.1.0';
    static riskLevel = 'high';
    static inputSchema = {
      type: 'object',
      required: [ 'actor', 'action' ],
      properties: {
        actor: { type: 'string', minLength: 1, maxLength: 64 },
        action: { type: 'string', pattern: ACTION_PATTERN },
        scope: { type: [ 'object', 'null' ], description: 'Scope to remove; null targets the unscoped grant' },
      },
    };

    async _execute(params = {}) {
      let { actor, action } = params;
      if (!actor || !action) throw new Error('policy_revoke requires actor and action');
      let scope = params.scope === undefined ? null : params.scope;

      let result = await db().query(
        `DELETE FROM miri_capability
          WHERE actor = $1 AND action = $2
            AND scope_json IS NOT DISTINCT FROM $3::jsonb`,
        [ actor, action, scopeText(scope) ],
      );
      let deleted = result?.rowCount ?? 0;
      return {
        actor,
        action,
        scope,
        deleted,
        // Explicitly distinguish "removed it" from "there was nothing there",
        // because both used to look like success.
        note: deleted === 0
          ? 'No matching grant existed; nothing was revoked.'
          : 'Grant removed.',
      };
    }
  }

  return {
    'miri:can': CanTool,
    'miri:policy_actors': ActorsTool,
    'miri:policy_roles': RolesTool,
    'miri:policy_who': WhoTool,
    'miri:policy_grant': GrantTool,
    'miri:policy_revoke': RevokeTool,
  };
}
