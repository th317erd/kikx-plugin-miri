'use strict';

// Harness: load kikx-plugin-miri the way Kikx's loader does, with fakes.
//
// Why this exists
// ---------------
// The server the owner runs loads /opt/plugins/kikx-plugin-miri from a baked image,
// so nothing in this repo can be exercised against it. That makes it easy to claim a
// change works because the file looks right. This harness runs setup() for real with
// a fake provide(), so registration, lifecycle and the event subscription are
// observed rather than assumed.
//
// It imports the real PluginEventBus from the sibling kikx checkout rather than
// reimplementing it: the whole point is that the bus delivers and the plugin used to
// name a session that did not exist.
//
// What it proves
//   - every tool module registers
//   - setup() returns an OBJECT with onInit (a returned function would be read as a
//     teardown and both hooks silently skipped)
//   - with no configured sessions the plugin subscribes to nothing and says so
//   - with configured sessions a real frame event reaches the handler, the delivery
//     counter increments, and other sessions are filtered out
//   - /health reports the subscription truthfully
//
// Run: node test/subscription.test.mjs   (exit 0 = pass)

import { PluginEventBus } from '../../kikx/src/core/plugins/plugin-events.mjs';
import { setup, pluginName } from '../index.mjs';

const out = [];
const ok = (label, cond, extra = '') => {
  out.push(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  return cond;
};

// --- fakes -----------------------------------------------------------------

class FakePluginInterface {
  static pluginID = 'unknown';
  static featureName = 'unknown';
  static riskLevel = 'none';
  static inputSchema = null;
}

function makeHarness({ config = {} } = {}) {
  const state = {
    tools: new Map(),
    subscriptions: [],
    httpHandlers: [],
    migrations: [],
    logs: [],
  };

  const bus = new PluginEventBus({ logger: { warn: (m) => state.logs.push(m) } });

  const registry = {
    getClass(name) { return name === 'PluginInterface' ? FakePluginInterface : null; },
    registerTool(name, cls) { state.tools.set(name, cls); },
  };

  // Mirrors the loader: subscribe() is only legal once the bus exists.
  const subscribe = (handler, options = {}) => {
    if (!bus) throw new Error('subscribe() called before the plugin event bus was attached');
    state.subscriptions.push({ handler, options });
    return bus.subscribe(pluginName, handler, options);
  };

  const readConfig = async (path, fallback = null) => {
    const value = Object.prototype.hasOwnProperty.call(config, path) ? config[path] : undefined;
    return value === undefined || value === null ? fallback : value;
  };

  const lifecycle = setup((callback) => callback({
    registry,
    mountHttp: (handler) => state.httpHandlers.push(handler),
    registerMigrations: (options) => state.migrations.push(options),
    subscribe,
    db: () => { throw new Error('db() is not exercised by this harness'); },
    authorize: async () => ({ allowed: false, reason: 'not exercised' }),
    readConfig,
  }));

  return { ...state, lifecycle, bus };
}

// A frame runtime stub with exactly the surface PluginEventBus uses.
function runtimeWithEvents() {
  const handlers = new Map();
  return {
    on(channel, handler) {
      if (!handlers.has(channel)) handlers.set(channel, []);
      handlers.get(channel).push(handler);
    },
    emit(channel, payload) {
      for (const handler of handlers.get(channel) || []) handler(payload);
    },
  };
}

// Drive the real mount handler and capture what it would have sent.
async function callMount(handler, { method = 'GET', subPath, body = Buffer.alloc(0) } = {}) {
  let statusCode = null;
  let payload = null;
  const response = {
    writeHead(code) { statusCode = code; },
    end(text) { payload = text ? JSON.parse(text) : null; },
  };
  await handler({
    request: { method },
    response,
    subPath,
    rawBody: body,
    json: () => ({}),
  });
  return { statusCode, payload };
}

// --- 1. registration and lifecycle shape -----------------------------------

{
  const h = makeHarness();
  ok('setup() returns an object, not a function', typeof h.lifecycle === 'object' && h.lifecycle !== null);
  ok('setup() declares onInit', typeof h.lifecycle.onInit === 'function');
  ok('setup() declares onShutdown', typeof h.lifecycle.onShutdown === 'function');
  ok('migrations were registered from sql/', h.migrations.length === 1 && h.migrations[0].directory === 'sql');
  ok('one HTTP mount was installed', h.httpHandlers.length === 1);

  const expected = [
    'miri:ping', 'miri:character_get', 'miri:character_set', 'miri:character_list',
    'miri:can', 'miri:policy_actors', 'miri:policy_roles', 'miri:policy_who',
    'miri:policy_grant', 'miri:policy_revoke',
    'miri:notes_add', 'miri:notes_get', 'miri:notes_list', 'miri:notes_search',
    'miri:notes_update', 'miri:notes_delete',
  ];
  const missing = expected.filter((n) => !h.tools.has(n));
  ok(
    `all ${expected.length} expected tools registered`,
    missing.length === 0 && h.tools.size === expected.length,
    missing.length ? 'missing: ' + missing.join(', ') : `got ${h.tools.size}`,
  );
}

// --- 2. unconfigured: subscribes to nothing, and says so -------------------

{
  const h = makeHarness();
  await h.lifecycle.onInit();

  ok('with no config, no subscription is made', h.subscriptions.length === 0);

  const { statusCode, payload } = await callMount(h.httpHandlers[0], { subPath: '/health' });
  ok('/health still answers 200 when unconfigured', statusCode === 200);
  ok('/health reports the subscription as unconfigured', payload.subscription.configured === false);
  ok('/health says nothing is delivered yet', /nothing is delivered/i.test(payload.subscription.note));
  ok('/health reports zero deliveries', payload.subscription.delivered === 0);
}

// --- 3. configured: a real event reaches the handler -----------------------

{
  const h = makeHarness({ config: { 'miri.event_sessions': 'sess-a, sess-b' } });
  await h.lifecycle.onInit();

  ok('with config, exactly one subscription is made', h.subscriptions.length === 1, `got ${h.subscriptions.length}`);
  const scoped = h.subscriptions[0]?.options?.sessions ?? [];
  ok(
    'the configured session list is parsed and de-duplicated',
    scoped.length === 2 && scoped[0] === 'sess-a' && scoped[1] === 'sess-b',
    JSON.stringify(scoped),
  );

  const runtime = runtimeWithEvents();
  h.bus.attach(runtime);

  runtime.emit('event', { sessionID: 'sess-a' });
  runtime.emit('event', { sessionID: 'sess-b' });
  runtime.emit('event', { sessionID: 'someone-else' });

  const { payload } = await callMount(h.httpHandlers[0], { subPath: '/health' });
  ok(
    'two subscribed events were delivered; the foreign session was filtered',
    payload.subscription.delivered === 2,
    `delivered=${payload.subscription.delivered}`,
  );
  ok('/health echoes the configured sessions', JSON.stringify(payload.subscription.sessions) === JSON.stringify([ 'sess-a', 'sess-b' ]));
  ok('/health reports the config as the source', payload.subscription.source === 'config');
  ok('/health reports ok when everything loaded', payload.ok === true);
}

// --- 4. array-form config is accepted too ----------------------------------

{
  const h = makeHarness({ config: { 'miri.event_sessions': [ 'only-one' ] } });
  await h.lifecycle.onInit();
  ok('array-form config is accepted', JSON.stringify(h.subscriptions[0]?.options?.sessions) === JSON.stringify([ 'only-one' ]));
}

console.log(out.join('\n'));
const pass = out.every((l) => l.startsWith('PASS'));
console.log('\nTOTAL:', out.length, '| RESULT:', pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
