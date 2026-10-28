'use strict';

// =============================================================================
// kikx-plugin-miri — Miri, as an external Kikx plugin
// =============================================================================
// Miri is Wyatt's assistant framework: character, ingestion, policy, tools.
// This plugin brings all of it into Kikx rather than duplicating what Kikx
// already does. Anything Kikx can express natively - sessions, scheduling,
// sub-agents, inter-bot messaging, todo storage - is used, not reimplemented.
//
// Table and database names owned by this plugin carry the `miri_` prefix.
// =============================================================================

export const pluginName = 'miri';

export function setup(provide) {
  return provide(({ registry, mountHttp, registerMigrations, subscribe, db }) => {
    // Core classes arrive through the plugin context. A plugin outside the kikx
    // tree cannot resolve the 'kikx' package name, so importing them is not an
    // option and registry.getClass is the sanctioned route.
    let PluginInterface = registry.getClass('PluginInterface');
    if (!PluginInterface)
      throw new Error('kikx-plugin-miri requires PluginInterface in plugin context');

    class PingTool extends PluginInterface {
      static pluginID = 'miri';
      static featureName = 'ping';
      static displayName = 'Miri ping';
      static description = 'Confirm the Miri plugin is loaded and reachable. Returns version and time.';
      static version = '0.1.0';
      static riskLevel = 'none';
      static inputSchema = { type: 'object', properties: {} };

      async _execute() {
        return {
          pong: true,
          plugin: 'miri',
          version: '0.1.0',
          now: new Date().toISOString(),
        };
      }
    }

    class CharacterGetTool extends PluginInterface {
      static pluginID = 'miri';
      static featureName = 'character_get';
      static displayName = 'Miri character';
      static description = "Return the acting character's persona and communication guidance.";
      static version = '0.1.0';
      // Reading the character is harmless; it is text the assistant already speaks from.
      static riskLevel = 'none';
      static inputSchema = {
        type: 'object',
        properties: {
          actor: { type: 'string', description: 'Actor name; defaults to miri' },
        },
      };

      async _execute(params = {}) {
        let actor = params.actor || 'miri';
        // scoped handle: only miri_* tables are reachable through it
        let row = await db().one(
          'SELECT actor, character, compressed, updated_at FROM miri_actor_character WHERE actor = $1',
          [actor],
        );
        if (!row)
          return { actor, source: 'missing', note: 'no character row for this actor', guidance: null };
        return {
          actor: row.actor,
          source: 'database',
          guidance: row.character,
          compressed: row.compressed,
          updatedAt: row.updated_at,
        };
      }
    }

    // Relative directories resolve against this plugin, so nothing here knows
    // where the plugin is installed.
    registerMigrations({ directory: 'sql' });

    // Scoped events: this plugin hears about the sessions it names, nothing else.
    subscribe((event) => console.log('[miri-plugin] event', event.sessionID), { sessions: ['probe'] });

    // One mount: everything under /api/plugins/miri/ arrives here and this handler
    // owns the routing. Body bytes are left untouched so a webhook signature can be
    // verified later; json() is opt-in.
    mountHttp(async ({ request, response, subPath, rawBody, json }) => {
      if (request.method === 'GET' && subPath === '/echo') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: true, plugin: 'miri', method: request.method,
          mount: '/api/plugins/miri/', subPath, rawBytes: rawBody.length,
        }));
        return;
      }

      if (request.method === 'POST' && subPath === '/echo') {
        let body = json();
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true, received: body, rawBytes: rawBody.length }));
        return;
      }

      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: `No route for ${request.method} ${subPath}` } }));
    });

    // Lifecycle hooks instead of a bare teardown function: onInit runs after every
    // provide callback, onShutdown before the process exits.
    registry._miriLifecycle = {
      onInit()  { console.log('[miri-plugin] onInit'); },
      onShutdown() { console.log('[miri-plugin] onShutdown'); },
    };

    registry.registerTool('miri:ping', PingTool);
    class CharacterSetTool extends PluginInterface {
      static pluginID = 'miri';
      static featureName = 'character_set';
      static displayName = 'Set Miri character';
      static description = "Store the acting character's persona. Replaces any existing row for that actor.";
      static version = '0.1.0';
      // Writes durable data the assistant will speak from on later turns.
      static riskLevel = 'high';
      static inputSchema = {
        type: 'object',
        required: ['character'],
        properties: {
          actor: { type: 'string', description: 'Actor name; defaults to miri' },
          character: { type: 'string', description: 'Full durable character description' },
          compressed: { type: 'string', description: 'Short version for the start brief' },
        },
      };

      async _execute(params = {}) {
        let actor = params.actor || 'miri';
        if (typeof params.character !== 'string' || !params.character.trim())
          throw new Error('character_set requires non-empty character text');

        await db().query(
          `INSERT INTO miri_actor_character (actor, character, compressed, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (actor) DO UPDATE
             SET character = EXCLUDED.character,
                 compressed = EXCLUDED.compressed,
                 updated_at = now()`,
          [actor, params.character, params.compressed || null],
        );

        let row = await db().one(
          'SELECT actor, character, updated_at FROM miri_actor_character WHERE actor = $1',
          [actor],
        );
        return { actor, saved: true, bytes: row.character.length, updatedAt: row.updated_at };
      }
    }

    registry.registerTool('miri:character_set', CharacterSetTool);
    registry.registerTool('miri:character_get', CharacterGetTool);

    return registry._miriLifecycle;
  });
}
