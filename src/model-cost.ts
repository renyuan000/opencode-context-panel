import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

export const planCost = (api: TuiPluginApi, message: AssistantMessage) => {
  if (message.providerID !== "opencode-go") return Number(message.cost ?? 0)
  const model = api.state.provider.find((item) => item.id === "opencode")?.models[message.modelID]
  if (!model?.cost) return Number(message.cost ?? 0)
  const tokens = message.tokens
  const value =
    (tokens.input * model.cost.input +
      (tokens.output + tokens.reasoning) * model.cost.output +
      tokens.cache.read * model.cost.cache.read +
      tokens.cache.write * model.cost.cache.write) /
    1_000_000
  return Number.isFinite(value) ? value : Number(message.cost ?? 0)
}
