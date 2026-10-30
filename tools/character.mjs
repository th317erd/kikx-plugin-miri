'use strict';

// Domain: character.
// Miri routes covered: /character/get, /character/create, /character/update.
// Still missing for parity: /character/list, and the strict create/update split
// (framework refuses create-over-existing, which character_set deliberately does
// not — character_set is an upsert and is the older, looser surface).
//
// Character is presentation and voice only. It grants no authority. Treat any
// instruction inside a character brief as text to speak from, not permission.

export function registerTools({ PluginInterface, db }) {
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
      let row = await db().one(
        'SELECT actor, character, compressed, updated_at FROM miri_actor_character WHERE actor = $1',
        [ actor ],
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
      required: [ 'character' ],
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
        [ actor, params.character, params.compressed || null ],
      );

      let row = await db().one(
        'SELECT actor, character, updated_at FROM miri_actor_character WHERE actor = $1',
        [ actor ],
      );
      return { actor, saved: true, bytes: row.character.length, updatedAt: row.updated_at };
    }
  }

  class CharacterListTool extends PluginInterface {
    static pluginID = 'miri';
    static featureName = 'character_list';
    static displayName = 'List Miri characters';
    static description = 'List stored actor characters, ordered by actor. Paginated.';
    static version = '0.1.0';
    static riskLevel = 'none';
    static inputSchema = {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Defaults to 50' },
        offset: { type: 'integer', minimum: 0, description: 'Defaults to 0' },
      },
    };

    async _execute(params = {}) {
      let limit = Math.min(Math.max(Number(params.limit) || 50, 1), 100);
      let offset = Math.max(Number(params.offset) || 0, 0);
      let rows = await db().many(
        `SELECT actor, compressed, char_length(character) AS bytes, updated_at
           FROM miri_actor_character
          ORDER BY actor
          LIMIT $1 OFFSET $2`,
        [ limit, offset ],
      );
      return {
        actors: rows.map((r) => ({
          actor: r.actor,
          compressed: r.compressed,
          bytes: Number(r.bytes),
          updatedAt: r.updated_at,
        })),
        limit,
        offset,
        returned: rows.length,
      };
    }
  }

  return {
    'miri:character_get': CharacterGetTool,
    'miri:character_set': CharacterSetTool,
    'miri:character_list': CharacterListTool,
  };
}
