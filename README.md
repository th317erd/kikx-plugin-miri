# kikx-plugin-miri

Miri — Wyatt's assistant framework — as an external Kikx plugin.

Miri is not a second framework running beside Kikx. Where Kikx already provides a capability
(sessions, scheduling, sub-agents, session merging, inter-bot messaging, todo storage, fuzzy
database search, bot storage) the plugin **uses Kikx** rather than reimplementing it. The plugin
contributes what is specific to Miri: the character, ingestion lanes, the authority model, and
Miri's own tools.

## Prefix

Anything this plugin owns in a database carries the **`miri_`** prefix on tables, and `miri` in any
database or schema name. This is a mandate, not a preference: an unprefixed table is a collision
waiting to happen inside a shared store.

## Status

Phase 1 — skeleton. Two tools prove the plugin loads, registers, and executes:

| Tool | Risk | Returns |
|---|---|---|
| `miri:ping` | none | `{ pong, plugin, version, now }` |
| `miri:character_get` | none | the acting character's guidance (currently a stub) |

## Install

Add the plugin directory to `KIKX_PLUGIN_PATHS` in the Kikx `.env`:

    KIKX_PLUGIN_PATHS=/path/to/kikx-plugin-miri:...

There is no build step and no dependencies.

## Notes for plugin authors

`PluginInterface` cannot be imported by package name from a plugin living outside the Kikx tree.
Take it from the plugin context:

    let PluginInterface = registry.getClass('PluginInterface');

Register tools with `registry.registerTool('miri:feature_name', ToolClass)`.
