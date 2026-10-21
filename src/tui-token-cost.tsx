/** @jsxImportSource @opentui/solid */
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal } from "solid-js"

const fmt = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

const money = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n < 0.001) return `$${n.toFixed(6)}`
  return `$${n.toFixed(4)}`
}

const latest = (messages: ReadonlyArray<{ role: string }> | undefined) => {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i]
    if (!item || item.role !== "assistant") continue
    const msg = item as AssistantMessage
    if (!msg.tokens || !(msg.tokens.output > 0)) continue
    return msg
  }
  return undefined
}

const positive = (value: unknown) => {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const tui: TuiPlugin = async (api, options) => {
  try {
    const limit = positive(options?.costWarnUsd) ?? positive(process.env.OPENCODE_COST_WARN_USD) ?? 0.5
    const [tick, setTick] = createSignal(0)
    const [blink, setBlink] = createSignal(true)
    const bump = () => setTick((value) => value + 1)
    const blinkTimer = setInterval(() => setBlink((value) => !value), 600)
    const offs = [
      api.event.on("message.updated", bump),
      api.event.on("message.removed", bump),
      api.event.on("session.updated", bump),
    ]
    api.lifecycle.onDispose(() => {
      clearInterval(blinkTimer)
      for (const off of offs) off()
    })

    api.slots.register({
      order: 100,
      slots: {
        session_prompt_right(ctx, props) {
          const msg = createMemo(() => {
            tick()
            if (!props.session_id) return undefined
            try {
              return latest(api.state.session.messages(props.session_id))
            } catch {
              return undefined
            }
          })
          const view = createMemo(() => {
            const m = msg()
            if (!m) return { text: "", alert: false }
            const t = m.tokens
            const alert = Number.isFinite(m.cost) && m.cost >= limit
            return {
              text: ` [${alert ? "⚠ " : ""}in ${fmt(t.input)} · out ${fmt(t.output)} · ${money(m.cost)}] `,
              alert,
            }
          })
          return (
            <text fg={view().alert && blink() ? ctx.theme.current.error : ctx.theme.current.textMuted}>
              {view().text}
            </text>
          )
        },
      },
    })
  } catch {
    return
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: "tui-token-cost",
  tui,
}

export default plugin
