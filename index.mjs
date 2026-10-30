'use strict';

// =============================================================================
// kikx-plugin-miri — Miri, as an external Kikx plugin
// =============================================================================
// Miri is Wyatt's assistant framework: character, authority, transport policy,
// notes, scheduled work. This plugin brings it into Kikx rather than duplicating
// what Kikx already does natively.
//
// STRUCTURE (2026-10-30, parity mission)
//   index.mjs          this hub: lifecycle, mounts, subscriptions, tool registry
//   tools/<domain>.mjs one module per Miri namespace family
//   sql/NNN-*.sql      forward-only migrations, all tables `miri_`-prefixed
//
// A tool module exports `registerTools(ctx)` and returns a map of
// `{ '<pluginID>:<featureName>': ToolClass }`. It receives ONLY the context it
// needs and must not import from another tool module. That keeps each domain
// independently editable — two workers can port /notes and /policy in parallel
// without touching the same file.
//
// Table and database names owned by this plugin carry the `miri_` prefix, which
// the scoped database handle enforces at runtime.
// =============================================================================

import * as pingTools from './tools/ping.mjs';
import * as characterTools from './tools/character.mjs';
import * as policyTools from './tools/policy.mjs';

export const pluginName = 'miri';

// Every tool module, in load order. Adding a domain means adding one line here
// and one file under tools/.
const TOOL_MODULES = [
  pingTools,
  characterTools,
  policyTools,
];

export function setup(provide) {
  return provide(({ registry, mountHttp, registerMigrations, subscribe, db, authorize }) => {
    // Core classes arrive through the plugin context. A plugin outside the kikx
    // tree cannot resolve the 'kikx' package name, so importing them is not an
    // option and registry.getClass is the sanctioned route.
    let PluginInterface = registry.getClass('PluginInterface');
    if (!PluginInterface)
      throw new Error('kikx-plugin-miri requires PluginInterface in plugin context');

    // The context a tool module is allowed to see. Deliberately small: a module
    // that wants something new asks for it here, in one place.
    const toolContext = {
      pluginID: 'miri',
      PluginInterface,
      db,
      authorize,
    };

    registerMigrations({ directory: 'sql' });

    // Load every domain module and register what it declares. A module that
    // throws is reported and skipped rather than taking the whole plugin down:
    // one broken domain should not disable character_get.
    const registered = [];
    const failedModules = [];
    for (const mod of TOOL_MODULES) {
      try {
        let tools = mod.registerTools(toolContext) || {};
        for (const [ name, ToolClass ] of Object.entries(tools)) {
          registry.registerTool(name, ToolClass);
          registered.push(name);
        }
      } catch (err) {
        failedModules.push(err?.message || String(err));
        console.error('[miri-plugin] tool module failed:', err?.message || err);
      }
    }

    // Loud, not silent. A domain that failed to register is a parity hole and
    // must be visible at startup rather than discovered later by a missing tool.
    console.log(`[miri-plugin] registered ${registered.length} tools: ${registered.join(', ')}`);
    if (failedModules.length)
      console.error(`[miri-plugin] ${failedModules.length} tool module(s) FAILED to load: ${failedModules.join('; ')}`);

    // Scoped events. NOTE: this subscription is a Phase 1 placeholder and is
    // still hardcoded to a non-existent session id 'probe'. Session-scoped
    // delivery to a handler has never been observed. Tracked as a known defect in
    // docs/kikx-miri/PARITY-MATRIX.md; do not treat it as working.
    subscribe((event) => console.log('[miri-plugin] event', event.sessionID), { sessions: [ 'probe' ] });

    // One mount: everything under /api/plugins/miri/ arrives here and this
    // handler owns the routing. Body bytes are left untouched so a webhook
    // signature can be verified later; json() is opt-in.
    mountHttp(async ({ request, response, subPath, rawBody, json }) => {
      const send = (code, body) => {
        response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(body));
      };

      // Parity is measurable from the outside: this endpoint reports exactly
      // which domains registered and which failed.
      if (request.method === 'GET' && subPath === '/health') {
        return send(200, {
          ok: failedModules.length === 0,
          plugin: 'miri',
          toolCount: registered.length,
          tools: registered,
          failedModules,
        });
      }

      if (request.method === 'GET' && subPath === '/echo') {
        return send(200, {
          ok: true, plugin: 'miri', method: request.method,
          mount: '/api/plugins/miri/', subPath, rawBytes: rawBody.length,
        });
      }

      if (request.method === 'POST' && subPath === '/echo') {
        return send(200, { ok: true, received: json(), rawBytes: rawBody.length });
      }

      return send(404, { error: { message: `No route for ${request.method} ${subPath}` } });
    });

    // Lifecycle hooks instead of a bare teardown function: onInit runs after every
    // provide callback, onShutdown before the process exits. Returning an OBJECT
    // is required — a returned function is read as a teardown and both hooks are
    // silently skipped.
    registry._miriLifecycle = {
      onInit() { console.log(`[miri-plugin] onInit (${registered.length} tools)`); },
      onShutdown() { console.log('[miri-plugin] onShutdown'); },
    };

    return registry._miriLifecycle;
  });
}
