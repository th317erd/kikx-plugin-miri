'use strict';

// Domain: liveness.
// Miri routes covered: none — this tool has no framework counterpart. It exists
// so an operator can prove the plugin is loaded, reachable, and knows which
// version it is speaking from before trusting anything else it reports.

export function registerTools({ PluginInterface }) {
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

  return { 'miri:ping': PingTool };
}
