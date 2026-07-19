import { endpointPlugin } from "./endpoint-plugin.ts"
import type { CheckPlugin } from "./types.ts"

const plugins = new Map<string, CheckPlugin>([
  [endpointPlugin.pluginId, endpointPlugin],
])

export function getCheckPlugin<Config = unknown, RawResult = unknown>(pluginId: string): CheckPlugin<Config, RawResult> {
  const plugin = plugins.get(pluginId || endpointPlugin.pluginId)
  if (!plugin) {
    throw new Error(`Unknown check plugin: ${pluginId}`)
  }

  return plugin as CheckPlugin<Config, RawResult>
}

export function listCheckPlugins() {
  return Array.from(plugins.values()).map((plugin) => ({
    pluginId: plugin.pluginId,
    displayName: plugin.displayName,
    configSchema: plugin.configSchema,
  }))
}

export { endpointPlugin }
