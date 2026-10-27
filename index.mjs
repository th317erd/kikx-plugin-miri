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
  provide(({ registry, registerRoute }) => {
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
        // Phase 1 stub: the character lives here until the database migration lands,
        // at which point this reads miri_actor_character instead.
        return {
          actor,
          source: 'stub',
          note: 'Phase 1: character text is not yet migrated to the plugin database.',
          guidance:
            'Miri is Wyatt\'s personal assistant: direct, concrete, leads with defects in her own ' +
            'work, states what she verified versus what she assumed, and never claims authority ' +
            'she has not been given.',
        };
      }
    }

    // registerRoute comes from the plugin context, already bound to this plugin's name.
    registerRoute('GET', '/plugin/miri/echo', async ({ request, response }) => {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, plugin: 'miri', method: request.method }));
    });

    registry.registerTool('miri:ping', PingTool);
    registry.registerTool('miri:character_get', CharacterGetTool);
  });
}
