import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

export const planCost = (api: TuiPluginApi, message: AssistantMessage) => {
  if (message.providerID !== "opencode-go") return Number(message.cost ?? 0)
  const model = api.state.provider.find((item) => item.id === "opencode")?.models[message.modelID]
  if (!model?.cost) return Number(message.cost ?? 0)
  const tokens = message.tokens
  const input = tokens.input ?? 0
  const output = (tokens.output ?? 0) + (tokens.reasoning ?? 0)
  const cacheRead = tokens.cache?.read ?? 0
  const cacheWrite = tokens.cache?.write ?? 0
  const value =
    (input * model.cost.input +
      output * model.cost.output +
      cacheRead * (model.cost.cache?.read ?? 0) +
      cacheWrite * (model.cost.cache?.write ?? 0)) /
    1_000_000
  return Number.isFinite(value) ? value : Number(message.cost ?? 0)
}
