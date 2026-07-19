import { getCheckPlugin } from "./plugins/registry.ts"
import type { EndpointTestInput, EndpointTestResult } from "./types.ts"
import type { CheckPluginRunOptions, NormalizedCheckResult } from "./plugins/types.ts"

export async function runEndpointTest(input: EndpointTestInput, options: CheckPluginRunOptions = {}): Promise<EndpointTestResult> {
  const plugin = getCheckPlugin<EndpointTestInput, EndpointTestResult>("endpoint")
  const config = plugin.validateConfig(input)
  return plugin.run(config, options)
}

export async function runEndpointPluginTest(input: EndpointTestInput, options: CheckPluginRunOptions = {}): Promise<NormalizedCheckResult> {
  const plugin = getCheckPlugin<EndpointTestInput, EndpointTestResult>("endpoint")
  const config = plugin.validateConfig(input)
  const result = await plugin.run(config, options)
  return plugin.normalizeResult(result, config)
}
