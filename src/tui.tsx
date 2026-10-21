/** @jsxImportSource @opentui/solid */
import { statSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiSidebarFileItem } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, onCleanup } from "solid-js"

const CONTEXT_ID = "internal:sidebar-context"
const FOOTER_ID = "internal:sidebar-footer"

const throwIfError = (result: unknown) => {
  if (result && typeof result === "object" && "error" in result) {
    const error = (result as { error?: unknown }).error
    if (error) throw error
  }
  return result
}

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

const chars = (value: unknown) => {
  if (typeof value === "string") return value.length
  if (value == null) return 0
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const countLabel = (n: number) => (n > 100 ? `前 100 / 共 ${n}` : `${n}`)

const backupDir = () =>
  process.env.OPENCODE_CONTEXT_BACKUP_DIR?.trim() ||
  join(homedir(), ".local", "share", "opencode", "context-backups")

const safeName = (value: string) => value.replace(/[^\w.-]/g, "-")

const ageText = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) return "未知"
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${Math.max(1, sec)}秒`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}分钟`
  const hour = Math.round(min / 60)
  if (hour < 24) return `${hour}小时`
  return `${Math.round(hour / 24)}天`
}

const STOP = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "your", "have",
  "please", "reply", "exactly", "only", "run", "use", "all", "not", "are", "was",
])

const tokenize = (text: string) => {
  const out = new Set<string>()
  for (const word of text.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []) {
    if (!STOP.has(word)) out.add(word)
  }
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

const relevanceOf = (text: string, topic: Set<string>) => {
  if (topic.size === 0) return 0
  const words = tokenize(text)
  if (words.size === 0) return 0
  let hit = 0
  for (const word of words) if (topic.has(word)) hit++
  return Math.min(100, Math.round((hit / Math.sqrt(words.size * topic.size)) * 100))
}

const importanceOf = (tool: string, output: string, turnsAgo: number) => {
  const name = tool.toLowerCase()
  let score = 45
  if (name === "skill" || name === "task") score += 30
  else if (name === "edit" || name === "write" || name === "patch" || name === "apply_patch") score += 20
  else if (name === "bash" || name === "shell") score += 10
  else if (name === "read" || name === "grep" || name === "glob" || name === "list") score -= 10
  if (/\b(error|failed|exception|denied|conflict)\b/i.test(output)) score += 10
  if (turnsAgo <= 2) score += 10
  else if (turnsAgo >= 10) score -= 10
  return Math.max(0, Math.min(100, score))
}

const importanceLabel = (score: number | undefined) => {
  if (score === undefined) return "?"
  if (score >= 70) return "高"
  if (score >= 40) return "中"
  return "低"
}

const scoreText = (importance: number | undefined, relevance: number | undefined) =>
  `重要 ${importanceLabel(importance)} · 相关 ${relevance ?? 0}%`

const metaText = (created: number, importance: number | undefined, relevance: number | undefined) =>
  `${created > 0 ? `${ageText(Date.now() - created)}前` : "时间未知"} · ${scoreText(importance, relevance)}`


type Candidate = {
  messageID: string
  partID: string
  tool: string
  title: string
  size: number
  preview: string
  created: number
  turnsAgo: number
  importance?: number
  relevance?: number
  part: Record<string, unknown>
}

type Restorable = Candidate & { compacted: number }

type TextCandidate = {
  messageID: string
  partID: string
  role: string
  preview: string
  size: number
  deletable: boolean
  created: number
  turnsAgo: number
  importance?: number
  relevance?: number
}

function topicOf(api: TuiPluginApi, messages: ReadonlyArray<{ id: string; role: string }>) {
  const texts: string[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0 && used < 2; i--) {
    const message = messages[i]
    if (!message || message.role !== "user") continue
    used++
    try {
      const parts = api.state.part(message.id) as unknown as ReadonlyArray<Record<string, unknown>>
      for (const part of parts) {
        if (part.type === "text" && !part.synthetic) texts.push(String(part.text ?? ""))
      }
    } catch {}
  }
  return tokenize(texts.join("\n"))
}


function collect(api: TuiPluginApi, sessionID: string, extras = true) {
  const messages = api.state.session.messages(sessionID)
  const lastUser = messages.map((item) => item.role).lastIndexOf("user")
  const start = messages.reduce(
    (acc, item, index) => (item.role === "assistant" && item.summary === true ? index : acc),
    0,
  )
  const userIndexes = messages.flatMap((item, index) => (item.role === "user" ? [index] : []))
  const topic = extras ? topicOf(api, messages) : new Set<string>()
  const sum = { user: 0, assistant: 0, reasoning: 0, tools: 0, files: 0, other: 0 }
  const unload: Candidate[] = []
  const restorable: Restorable[] = []
  const texts: TextCandidate[] = []

  for (const [index, message] of messages.entries()) {
    if (index < start) continue
    const created = Number((message as { time?: { created?: number } }).time?.created ?? 0)
    const turnsAgo = userIndexes.reduce((count, userIndex) => count + (userIndex > index ? 1 : 0), 0)
    let parts: ReadonlyArray<Record<string, unknown>> = []
    try {
      parts = api.state.part(message.id) as unknown as ReadonlyArray<Record<string, unknown>>
    } catch {
      continue
    }
    for (const part of parts) {
      if (part.ignored) continue
      const type = part.type
      const text = part.text
      if (type === "text") {
        const size = chars(text)
        if (message.role === "user") sum.user += size
        else sum.assistant += size
        if (extras && message.summary !== true && !part.synthetic && size > 0) {
          const preview = clip(String(text ?? "").replace(/\s+/g, " ").trim(), 400)
          const base = message.role === "user" ? 60 : 45
          const importance = Math.max(0, Math.min(100, base + (turnsAgo <= 2 ? 10 : 0) + (size > 2000 ? 10 : 0)))
          texts.push({
            messageID: message.id,
            partID: String(part.id),
            role: message.role,
            preview,
            size,
            deletable: message.role === "assistant" || index < lastUser,
            created,
            turnsAgo,
            importance,
            relevance: relevanceOf(String(text ?? ""), topic),
          })
        }
        continue
      }
      if (type === "reasoning") {
        sum.reasoning += chars(text)
        continue
      }
      if (type === "tool") {
        const state = part.state as Record<string, unknown> | undefined
        const output = state?.output
        const input = state?.input
        const compacted = (state?.time as Record<string, unknown> | undefined)?.compacted
        sum.tools += (compacted ? 0 : chars(output)) + chars(input)
        const title = typeof state?.title === "string" ? state.title : ""
        const preview = clip(String(output ?? "").replace(/\s+/g, " ").trim(), 400)
        const base = {
          messageID: message.id,
          partID: String(part.id),
          tool: String(part.tool),
          title,
          size: chars(output),
          preview,
          created,
          turnsAgo,
          importance: importanceOf(String(part.tool), preview, turnsAgo),
          ...(extras ? { relevance: relevanceOf(`${title} ${preview}`, topic) } : {}),
          part,
        }
        if (extras && state?.status === "completed" && compacted) {
          restorable.push({ ...base, compacted: Number(compacted) })
        }
        if (state?.status === "completed" && !compacted && index < messages.length - 1) {
          unload.push(base)
        }
        continue
      }
      if (type === "step-start" || type === "step-finish" || type === "snapshot" || type === "retry") continue
      if (type === "file") {
        sum.files += chars(part.source) + chars(part.filename)
        continue
      }
      sum.other += chars(part)
    }
  }

  unload.sort((a, b) => b.size - a.size)
  restorable.sort((a, b) => b.compacted - a.compacted)
  texts.reverse()
  return { sum, unload, restorable, texts }
}

function scan(api: TuiPluginApi, sessionID: string) {
  const { sum, unload } = collect(api, sessionID, false)
  return {
    sum,
    unload: unload.slice(0, 3).map((item) => ({
      label: clip(`${item.tool}[${importanceLabel(item.importance)}] ${item.title || item.preview}`.trim(), 24),
      size: item.size,
    })),
    unloadCount: unload.length,
    unloadTotal: unload.reduce((total, item) => total + item.size, 0),
  }
}

function Panel(props: { api: TuiPluginApi; session_id: string; tick: () => number }) {
  const theme = () => props.api.theme.current
  const data = createMemo(() => {
    props.tick()
    const messages = props.api.state.session.messages(props.session_id)
    const last = [...messages]
      .reverse()
      .find((item): item is AssistantMessage => item.role === "assistant" && item.tokens?.output > 0)
    const session = props.api.state.session.get(props.session_id)
    const model = last
      ? props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
      : undefined
    const sent = last ? last.tokens.input + last.tokens.cache.read + last.tokens.cache.write : 0
    const total = last
      ? last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
      : 0
    const hit = sent > 0 && last ? Math.round((last.tokens.cache.read / sent) * 100) : 0
    const limit = model?.limit.context ?? 0
    const scanResult = scan(props.api, props.session_id)
    return {
      last,
      total,
      sent,
      hit,
      percent: limit > 0 ? Math.round((total / limit) * 100) : 0,
      limit,
      cost: last?.cost ?? 0,
      sessionCost: session?.cost ?? 0,
      ...scanResult,
    }
  })

  return (
    <box gap={0}>
      <text fg={theme().text} onMouseUp={() => showContext(props.api)}>
        <b>Context</b>
        <span style={{ fg: theme().textMuted }}> (点击管理)</span>
      </text>
      <text fg={theme().textMuted}>
        {fmt(data().total)} tokens · {data().percent}% used
      </text>
      <text fg={theme().textMuted}>
        本次 命中 {data().hit}% ({fmt(data().last?.tokens.cache.read ?? 0)}) · 发 {fmt(data().sent)}
      </text>
      <text fg={theme().textMuted}>
        收 {fmt(data().last?.tokens.output ?? 0)} · 推理 {fmt(data().last?.tokens.reasoning ?? 0)} ·{" "}
        {money(data().cost)}
      </text>
      <text fg={theme().textMuted}>会话累计 {money(data().sessionCost)}</text>
      <text fg={theme().text}>
        <b>组成</b>
        <span style={{ fg: theme().textMuted }}> (字符估算)</span>
      </text>
      <text fg={theme().textMuted}>
        工具 {fmt(data().sum.tools / 4)} · 用户 {fmt(data().sum.user / 4)}
      </text>
      <text fg={theme().textMuted}>
        助手 {fmt(data().sum.assistant / 4)} · 文件 {fmt(data().sum.files / 4)}
      </text>
      <text fg={theme().textMuted}>
        推理 {fmt(data().sum.reasoning / 4)} · 其他 {fmt(data().sum.other / 4)}
      </text>
      <text fg={theme().text} onMouseUp={() => showUnload(props.api)}>
        <b>可卸载</b>
        <span style={{ fg: theme().textMuted }}>
          {" "}
          (按占用 · 估算 {fmt(data().unloadTotal / 4)} · {data().unloadCount} 项)
        </span>
      </text>
      {data().unload.length === 0 ? (
        <text fg={theme().textMuted}>无历史工具输出</text>
      ) : (
        data().unload.map((item) => (
          <text fg={theme().textMuted}>
            · {item.label} {fmt(item.size / 4)}
          </text>
        ))
      )}
      {data().percent >= 70 ? (
        <text fg={theme().warning}>建议 /compact 压缩上下文</text>
      ) : null}
      <text fg={theme().textMuted} onMouseUp={() => showContext(props.api)}>
        Ctrl+P 搜 Context 管理 / 点击打开
      </text>
    </box>
  )
}

type FileSort = "changes" | "time" | "size"

const FILE_SORT_LABEL: Record<FileSort, string> = { changes: "改动量", time: "时间", size: "大小" }

const nextFileSort = (sort: FileSort): FileSort =>
  sort === "changes" ? "time" : sort === "time" ? "size" : "changes"

function Files(props: { api: TuiPluginApi; session_id: string; tick: () => number }) {
  const theme = () => props.api.theme.current
  const [sort, setSort] = createSignal<FileSort>("changes")
  const rows = createMemo(() => {
    props.tick()
    const session = props.api.state.session.get(props.session_id)
    const dir = session?.directory || props.api.state.path.directory
    let list: ReadonlyArray<TuiSidebarFileItem> = []
    try {
      list = props.api.state.session.diff(props.session_id)
    } catch {
      return []
    }
    const items = list.map((item) => {
      let mtime = 0
      let size = 0
      try {
        const stat = statSync(isAbsolute(item.file) ? item.file : join(dir, item.file))
        mtime = stat.mtimeMs
        size = stat.size
      } catch {}
      return { ...item, mtime, size, changes: item.additions + item.deletions }
    })
    const mode = sort()
    items.sort((a, b) => {
      const primary =
        mode === "time" ? b.mtime - a.mtime : mode === "size" ? b.size - a.size : b.changes - a.changes
      return primary || a.file.localeCompare(b.file)
    })
    return items
  })
  const detail = (item: { mtime: number; size: number; changes: number }) =>
    sort() === "time"
      ? item.mtime > 0
        ? `${ageText(Date.now() - item.mtime)}前`
        : "时间未知"
      : sort() === "size"
        ? fmt(item.size)
        : fmt(item.changes)

  return (
    <box gap={0}>
      <text fg={theme().text} onMouseUp={() => setSort((value) => nextFileSort(value))}>
        <b>修改文件</b>
        <span style={{ fg: theme().textMuted }}>
          {" "}
          ({FILE_SORT_LABEL[sort()]} · {rows().length} · 点击切换)
        </span>
      </text>
      {rows().length === 0 ? (
        <text fg={theme().textMuted}>无修改文件</text>
      ) : (
        rows()
          .slice(0, 10)
          .map((item) => (
            <text fg={theme().textMuted}>
              <span>{clip(item.file, 26)}</span>{" "}
              <span style={{ fg: theme().success }}>+{item.additions}</span>
              <span style={{ fg: theme().error }}>-{item.deletions}</span>{" "}
              <span>{detail(item)}</span>
            </text>
          ))
      )}
    </box>
  )
}

type QuotaWindow = {
  status: string
  percent: number
  resetsAt: string
}

type QuotaData = {
  rolling: QuotaWindow
  weekly: QuotaWindow
  monthly: QuotaWindow
}

type QuotaKey = keyof QuotaData

const QUOTA_KEYS: QuotaKey[] = ["rolling", "weekly", "monthly"]
const QUOTA_LABEL: Record<QuotaKey, string> = { rolling: "5h", weekly: "周", monthly: "月" }

const positiveNumber = (value: unknown) => {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const countdown = (ms: number) => {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  const total = Math.floor(ms / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

const nextUtcReset = () => {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
}

const parseQuotaWindow = (value: unknown): QuotaWindow | undefined => {
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  const percent = Number(record.percent)
  const resetsAt = typeof record.resetsAt === "string" ? record.resetsAt : ""
  const status = typeof record.status === "string" ? record.status : "unknown"
  if (!Number.isFinite(percent) || !resetsAt) return
  return { status, percent: Math.max(0, Math.min(100, percent)), resetsAt }
}

const parseQuota = (value: unknown): QuotaData | undefined => {
  if (!value || typeof value !== "object") return
  const usage = (value as Record<string, unknown>).usage
  if (!usage || typeof usage !== "object") return
  const record = usage as Record<string, unknown>
  const rolling = parseQuotaWindow(record.rolling)
  const weekly = parseQuotaWindow(record.weekly)
  const monthly = parseQuotaWindow(record.monthly)
  if (!rolling || !weekly || !monthly) return
  return { rolling, weekly, monthly }
}

function Quota(props: { api: TuiPluginApi; session_id: string; options?: Record<string, unknown> }) {
  const theme = () => props.api.theme.current
  const [data, setData] = createSignal<QuotaData>()
  const [error, setError] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
  const [rates, setRates] = createSignal<Partial<Record<QuotaKey, number>>>({})
  const previous = new Map<QuotaKey, { percent: number; at: number }>()
  let switched = false
  let refreshing = false
  let scheduled: ReturnType<typeof setTimeout> | undefined

  const option = (name: string) => props.options?.[name]
  const usageUrl =
    (typeof option("usageUrl") === "string" ? (option("usageUrl") as string) : undefined) ||
    process.env.OPENCODE_GO_USAGE_URL ||
    "https://opencode.ai/zen/go/v1/usage"
  const fallbackRaw =
    (typeof option("fallbackModel") === "string" ? (option("fallbackModel") as string) : undefined) ||
    process.env.OPENCODE_GO_FALLBACK ||
    ""
  const autoSwitch = option("autoSwitch") !== false && Boolean(fallbackRaw)
  const pollMs = Math.max(
    30000,
    positiveNumber(option("pollMs")) ?? positiveNumber(process.env.OPENCODE_QUOTA_POLL_MS) ?? 120000,
  )

  const apiKey = () => {
    const explicit = typeof option("apiKey") === "string" ? (option("apiKey") as string) : undefined
    const provider = props.api.state.provider.find((item) => item.id === "opencode-go")
    const fromProvider =
      provider?.key ||
      (typeof provider?.options?.apiKey === "string" ? (provider.options.apiKey as string) : undefined)
    const key = explicit || fromProvider || process.env.OPENCODE_GO_API_KEY || process.env.OPENCODE_API_KEY
    return key?.replace(/^Bearer\s+/i, "")
  }

  const fallback = () => {
    const raw = fallbackRaw.trim()
    const slash = raw.indexOf("/")
    if (slash <= 0 || slash === raw.length - 1) return
    return { providerID: raw.slice(0, slash), id: raw.slice(slash + 1) }
  }

  const updateRates = (next: QuotaData) => {
    const at = Date.now()
    const values: Partial<Record<QuotaKey, number>> = { ...rates() }
    for (const key of QUOTA_KEYS) {
      const sample = next[key]
      const last = previous.get(key)
      if (last && sample.percent >= last.percent) {
        const hours = (at - last.at) / 3_600_000
        if (hours > 0) values[key] = (sample.percent - last.percent) / hours
      } else if (last && sample.percent < last.percent) {
        delete values[key]
      }
      previous.set(key, { percent: sample.percent, at })
    }
    setRates(values)
  }

  const maybeSwitch = (next: QuotaData) => {
    if (!autoSwitch) return
    const target = fallback()
    if (!target) return
    const exhausted = QUOTA_KEYS.some((key) => next[key].status !== "ok" || next[key].percent >= 100)
    if (!exhausted) {
      switched = false
      return
    }
    if (switched) return
    switched = true
    void props.api.client.v2.session
      .switchModel({ sessionID: props.session_id, model: target })
      .then((result) => {
        throwIfError(result)
        props.api.ui.toast({ variant: "warning", message: `Go 配额已用尽，已切换到 ${target.providerID}/${target.id}` })
      })
      .catch((cause: unknown) => {
        props.api.ui.toast({ variant: "error", message: `自动切换模型失败: ${String(cause)}` })
      })
  }

  const refresh = async () => {
    if (refreshing) return
    refreshing = true
    try {
      const key = apiKey()
      if (!key) {
        setError("未配置 Go API key")
        return
      }
      const response = await fetch(usageUrl, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) {
        setError(`配额查询失败 HTTP ${response.status}`)
        return
      }
      const next = parseQuota(await response.json())
      if (!next) {
        setError("配额返回格式异常")
        return
      }
      setError("")
      setData(next)
      updateRates(next)
      maybeSwitch(next)
    } catch {
      setError("配额查询失败")
    } finally {
      refreshing = false
    }
  }

  const schedule = () => {
    if (scheduled) return
    scheduled = setTimeout(() => {
      scheduled = undefined
      void refresh()
    }, 2500)
  }

  const nowTimer = setInterval(() => setNow(Date.now()), 1000)
  const pollTimer = setInterval(() => void refresh(), pollMs)
  const off = props.api.event.on("message.updated", schedule)
  onCleanup(() => {
    clearInterval(nowTimer)
    clearInterval(pollTimer)
    if (scheduled) clearTimeout(scheduled)
    off()
  })
  void refresh()

  return (
    <box gap={0}>
      <text fg={theme().text}>
        <b>Go 配额</b>
        <span style={{ fg: theme().textMuted }}> ($10 订阅 · 百分比)</span>
      </text>
      {error() ? (
        <text fg={theme().warning}>{error()}</text>
      ) : data() ? (
        QUOTA_KEYS.map((key) => {
          const window = data()![key]
          const rate = rates()[key]
          const color =
            window.status !== "ok" || window.percent >= 100
              ? theme().error
              : window.percent >= 80
                ? theme().warning
                : theme().textMuted
          return (
            <text fg={color}>
              {QUOTA_LABEL[key]} {bar(window.percent, 100, 8)} {Math.round(window.percent)}% ·{" "}
              {countdown(new Date(window.resetsAt).getTime() - now())}
              {rate !== undefined ? ` · ${rate.toFixed(1)}%/h` : ""}
            </text>
          )
        })
      ) : (
        <text fg={theme().textMuted}>查询中…</text>
      )}
      <text fg={theme().textMuted}>免费额度重置 {countdown(nextUtcReset() - now())} (UTC 00:00 估算)</text>
    </box>
  )
}

function Footer(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const path = createMemo(() => {
    const session = props.api.state.session.get(props.session_id)
    const dir = session?.directory || props.api.state.path.directory
    const home = typeof process !== "undefined" ? process.env.HOME : undefined
    const short = home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir
    const branch = session?.directory === props.api.state.path.directory ? props.api.state.vcs?.branch : undefined
    const text = branch ? `${short}:${branch}` : short
    const list = text.split("/")
    return { parent: list.slice(0, -1).join("/"), name: list.at(-1) ?? "" }
  })
  return (
    <box gap={1}>
      <text>
        <span style={{ fg: theme().textMuted }}>{path().parent}/</span>
        <span style={{ fg: theme().text }}>{path().name}</span>
      </text>
      <text fg={theme().textMuted}>
        <span style={{ fg: theme().success }}>•</span> <b>Open</b>
        <span style={{ fg: theme().text }}>
          <b>Code</b>
        </span>{" "}
        <span>{props.api.app.version}</span>
      </text>
    </box>
  )
}

function findPart(api: TuiPluginApi, messageID: string, partID: string) {
  try {
    const parts = api.state.part(messageID) as unknown as ReadonlyArray<Record<string, unknown>>
    return parts.find((part) => String(part.id) === partID)
  } catch {
    return undefined
  }
}

async function unload(api: TuiPluginApi, sessionID: string, item: Candidate) {
  const part = findPart(api, item.messageID, item.partID)
  if (!part) {
    api.ui.toast({ variant: "info", message: "该段落已不存在" })
    return
  }
  const state = part.state as Record<string, unknown>
  const time = (state.time as Record<string, unknown> | undefined) ?? {}
  if (time.compacted) {
    api.ui.toast({ variant: "info", message: "该段落已卸载" })
    return
  }
  try {
    const payload = {
      sessionID,
      messageID: item.messageID,
      partID: item.partID,
      part: { ...part, state: { ...state, time: { ...time, compacted: Date.now() } } },
    } as unknown as Parameters<typeof api.client.part.update>[0]
    throwIfError(await api.client.part.update(payload))
    api.ui.toast({
      variant: "success",
      message: `已卸载 ${item.tool} (${fmt(item.size / 4)} tokens)`,
    })
  } catch (error) {
    api.ui.toast({ variant: "error", message: `卸载失败: ${String(error)}` })
  }
}

async function restore(api: TuiPluginApi, sessionID: string, item: Restorable) {
  const part = findPart(api, item.messageID, item.partID)
  if (!part) {
    api.ui.toast({ variant: "info", message: "该段落已不存在" })
    return
  }
  const state = part.state as Record<string, unknown>
  const time = { ...((state.time as Record<string, unknown> | undefined) ?? {}) }
  if (!time.compacted) {
    api.ui.toast({ variant: "info", message: "该段落未被卸载" })
    return
  }
  delete time.compacted
  try {
    const payload = {
      sessionID,
      messageID: item.messageID,
      partID: item.partID,
      part: { ...part, state: { ...state, time } },
    } as unknown as Parameters<typeof api.client.part.update>[0]
    throwIfError(await api.client.part.update(payload))
    api.ui.toast({ variant: "success", message: `已恢复 ${item.tool}` })
  } catch (error) {
    api.ui.toast({ variant: "error", message: `恢复失败: ${String(error)}` })
  }
}

type DeleteResult = { ok: true; dir: string } | { ok: false; error: string }

async function deleteTextPart(api: TuiPluginApi, sessionID: string, item: TextCandidate): Promise<DeleteResult> {
  if (!item.deletable) return { ok: false, error: "当前用户输入不可删除" }
  const part = findPart(api, item.messageID, item.partID)
  if (!part) return { ok: false, error: "该段落已不存在" }
  if (part.type !== "text") return { ok: false, error: "该段落已不是正文" }
  const dir = backupDir()
  const file = join(dir, `${safeName(sessionID)}-${safeName(item.partID)}.txt`)
  const text = String(part.text ?? "")
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(
      file,
      `session: ${sessionID}\nmessage: ${item.messageID}\npart: ${item.partID}\nrole: ${item.role}\n\n${text}\n`,
      { encoding: "utf8", mode: 0o600 },
    )
  } catch (error) {
    return { ok: false, error: `备份失败，已取消删除: ${String(error)}` }
  }
  try {
    throwIfError(await api.client.part.delete({ sessionID, messageID: item.messageID, partID: item.partID }))
    return { ok: true, dir }
  } catch (error) {
    return { ok: false, error: `删除失败: ${String(error)}` }
  }
}

async function removeText(api: TuiPluginApi, sessionID: string, item: TextCandidate) {
  const result = await deleteTextPart(api, sessionID, item)
  api.ui.toast(
    result.ok
      ? { variant: "success", message: `已删除，备份在 ${result.dir}/` }
      : { variant: "error", message: result.error },
  )
}

async function removeTexts(api: TuiPluginApi, sessionID: string, items: TextCandidate[]) {
  let deleted = 0
  const errors: string[] = []
  for (const item of items) {
    const result = await deleteTextPart(api, sessionID, item)
    if (result.ok) deleted++
    else errors.push(result.error)
  }
  const message =
    errors.length === 0
      ? `已删除 ${deleted} 个文本块。\n\n备份目录：${backupDir()}/`
      : `已删除 ${deleted} 个，失败 ${errors.length} 个。\n\n首个错误：${errors[0]}\n备份目录：${backupDir()}/`
  const DialogAlert = api.ui.DialogAlert
  api.ui.dialog.replace(() => (
    <DialogAlert
      title={errors.length === 0 ? "批量删除完成" : "批量删除部分失败"}
      message={`${message}\n\n点击“确定”返回批量删除列表。`}
      onConfirm={() => {
        api.ui.dialog.clear()
        showDeleteRange(api)
      }}
    />
  ))
}

async function resetSidebar(api: TuiPluginApi) {
  const ids = [CONTEXT_ID, FOOTER_ID]
  let count = 0
  for (const id of ids) {
    if (api.plugins.list().find((entry) => entry.id === id)?.active) continue
    if (await api.plugins.activate(id).catch(() => false)) count++
  }
  api.ui.toast({
    variant: count > 0 ? "success" : "info",
    message: count > 0 ? `已恢复 ${count} 个内置侧栏，重启后生效` : "内置侧栏已启用",
  })
}

function currentSessionID(api: TuiPluginApi) {
  const route = api.route.current
  if (route.name !== "session") return
  const id = route.params?.sessionID
  return typeof id === "string" ? id : undefined
}

function showUnload(api: TuiPluginApi) {
  const sessionID = currentSessionID(api)
  if (!sessionID) {
    api.ui.toast({ variant: "warning", message: "请在会话中打开" })
    return
  }
  const list = collect(api, sessionID).unload
  if (list.length === 0) {
    api.ui.toast({
      variant: "info",
      message: "没有可卸载的工具输出（需已完成、未卸载，且不在当前最后一轮）",
    })
    return
  }
  const DialogSelect = api.ui.DialogSelect
  const DialogConfirm = api.ui.DialogConfirm
  const options = list.slice(0, 100).map((item) => ({
    title: `${item.tool} · ${fmt(item.size / 4)} · ${importanceLabel(item.importance)}`,
    value: item,
    description:
      clip(`${metaText(item.created, item.importance, item.relevance)} · ${item.title || item.preview}`.trim(), 140) ||
      "(无预览)",
  }))
  api.ui.dialog.replace(() => (
    <DialogSelect
      title={`卸载上下文 (按占用排序 · ${countLabel(list.length)} 项)`}
      placeholder="搜索工具输出"
      options={options}
      onSelect={(option) => {
        const item = option.value as Candidate
        api.ui.dialog.replace(() => (
          <DialogConfirm
            title="卸载工具输出"
            message={`${item.tool} · ${fmt(item.size / 4)} tokens · ${metaText(item.created, item.importance, item.relevance)}\n\n${clip(item.preview, 300)}\n\n下一轮起该输出替换为 [Old tool result content cleared]。原文仍保留在数据库，可用“恢复已卸载输出”还原。`}
            onConfirm={() => {
              api.ui.dialog.clear()
              void unload(api, sessionID, item)
            }}
            onCancel={() => api.ui.dialog.clear()}
          />
        ))
      }}
    />
  ))
}

function showRestore(api: TuiPluginApi) {
  const sessionID = currentSessionID(api)
  if (!sessionID) {
    api.ui.toast({ variant: "warning", message: "请在会话中打开" })
    return
  }
  const list = collect(api, sessionID).restorable
  if (list.length === 0) {
    api.ui.toast({ variant: "info", message: "没有已卸载的工具输出" })
    return
  }
  const DialogSelect = api.ui.DialogSelect
  const DialogConfirm = api.ui.DialogConfirm
  const options = list.slice(0, 100).map((item) => ({
    title: `${item.tool} · ${fmt(item.size / 4)} · ${importanceLabel(item.importance)}`,
    value: item,
    description:
      clip(
        `卸载于 ${ageText(Date.now() - item.compacted)}前 · ${scoreText(item.importance, item.relevance)} · ${item.title || item.preview}`,
        140,
      ) || "(无预览)",
  }))
  api.ui.dialog.replace(() => (
    <DialogSelect
      title={`恢复已卸载 (最近卸载优先 · ${countLabel(list.length)} 项)`}
      placeholder="搜索已卸载输出"
      options={options}
      onSelect={(option) => {
        const item = option.value as Restorable
        api.ui.dialog.replace(() => (
          <DialogConfirm
            title="恢复工具输出"
            message={`${item.tool} · ${fmt(item.size / 4)} tokens · 卸载于 ${ageText(Date.now() - item.compacted)}前 · ${scoreText(item.importance, item.relevance)}\n\n${clip(item.preview, 300)}\n\n恢复后下一轮重新进入上下文。`}
            onConfirm={() => {
              api.ui.dialog.clear()
              void restore(api, sessionID, item)
            }}
            onCancel={() => api.ui.dialog.clear()}
          />
        ))
      }}
    />
  ))
}

type DeleteChoice = { kind: "range" } | { kind: "text"; item: TextCandidate }

const textRowTitle = (item: TextCandidate) =>
  `[${item.deletable ? "可删" : "不可删"}] ${item.role === "user" ? "用户" : "输出"} · ${clip(item.preview, 28) || "(空)"}`

const textRowDescription = (item: TextCandidate) =>
  clip(`${metaText(item.created, item.importance, item.relevance)} · ${item.preview}`.trim(), 120) || "(无预览)"

function showDelete(api: TuiPluginApi) {
  const sessionID = currentSessionID(api)
  if (!sessionID) {
    api.ui.toast({ variant: "warning", message: "请在会话中打开" })
    return
  }
  const list = collect(api, sessionID).texts.filter((item) => item.deletable)
  if (list.length === 0) {
    api.ui.toast({ variant: "info", message: "没有可删除的历史正文" })
    return
  }
  const DialogSelect = api.ui.DialogSelect
  const DialogConfirm = api.ui.DialogConfirm
  const options: Array<{ title: string; value: DeleteChoice; description?: string }> = [
    {
      title: "批量删除连续文本块…",
      value: { kind: "range" },
      description: "选择起始块和结束块，一次删除区间内的可删块",
    },
    ...list.slice(0, 100).map((item) => ({
      title: `${item.role === "user" ? "用户" : "助手"} · ${clip(item.preview, 18) || "(空)"}`,
      value: { kind: "text" as const, item },
      description: textRowDescription(item),
    })),
  ]
  api.ui.dialog.replace(() => (
    <DialogSelect
      title={`删除正文 (最近优先 · ${countLabel(list.length)} 项)`}
      placeholder="搜索正文段落，或选择批量删除"
      options={options}
      onSelect={(option) => {
        const value = option.value as DeleteChoice
        if (value.kind === "range") {
          showDeleteRange(api)
          return
        }
        const item = value.item
        api.ui.dialog.replace(() => (
          <DialogConfirm
            title="永久删除正文"
            message={`${item.role === "user" ? "用户" : "助手"}正文 · 不可恢复 · ${metaText(item.created, item.importance, item.relevance)}\n\n${clip(item.preview, 300)}\n\n删除后无法还原（会先备份到 ${backupDir()}/），建议优先使用“卸载上下文段落”。`}
            onConfirm={() => {
              api.ui.dialog.clear()
              void removeText(api, sessionID, item)
            }}
            onCancel={() => api.ui.dialog.clear()}
          />
        ))
      }}
    />
  ))
}

function confirmDeleteRange(api: TuiPluginApi, sessionID: string, items: TextCandidate[]) {
  const DialogConfirm = api.ui.DialogConfirm
  const preview = items
    .slice(0, 3)
    .map((item, index) => `${index + 1}. [${item.role === "user" ? "用户" : "输出"}] ${clip(item.preview, 70)}`)
    .join("\n")
  const more = items.length > 3 ? `\n… 另有 ${items.length - 3} 块` : ""
  const lastMessageID = api.state.session.messages(sessionID).at(-1)?.id
  const touchesLast = lastMessageID ? items.some((item) => item.messageID === lastMessageID) : false
  const warning = touchesLast ? "\n\n注意：这次包含当前最后一轮内容，删除后会话界面可能变空。" : ""
  api.ui.dialog.replace(() => (
    <DialogConfirm
      title={`删除 ${items.length} 个连续文本块`}
      message={`将删除区间内的 ${items.length} 个可删文本块；当前用户输入、工具、系统和不可删块会跳过。\n\n${preview}${more}${warning}\n\n删除不可恢复，会先备份到 ${backupDir()}/。`}
      onConfirm={() => {
        api.ui.dialog.clear()
        void removeTexts(api, sessionID, items)
      }}
      onCancel={() => api.ui.dialog.clear()}
    />
  ))
}

function showDeleteRange(api: TuiPluginApi) {
  const sessionID = currentSessionID(api)
  if (!sessionID) {
    api.ui.toast({ variant: "warning", message: "请在会话中打开" })
    return
  }
  const all = collect(api, sessionID).texts.slice(0, 100)
  if (!all.some((item) => item.deletable)) {
    api.ui.toast({ variant: "info", message: "没有可删除的历史正文" })
    return
  }
  const indexOf = (item: TextCandidate) =>
    all.findIndex((entry) => entry.messageID === item.messageID && entry.partID === item.partID)
  const DialogSelect = api.ui.DialogSelect
  const options = all.map((item) => ({
    title: textRowTitle(item),
    value: item,
    description: textRowDescription(item),
    disabled: !item.deletable,
  }))
  api.ui.dialog.replace(() => (
    <DialogSelect
      title={`批量删除：选择起始块 (最近优先 · ${countLabel(all.length)} 项)`}
      placeholder="搜索起始文本块"
      options={options}
      onSelect={(option) => {
        const start = option.value as TextCandidate
        const startIndex = indexOf(start)
        if (startIndex < 0 || !start.deletable) {
          api.ui.toast({ variant: "info", message: "请选择可删文本块" })
          return
        }
        const rest = all.slice(startIndex)
        const restOptions = rest.map((item) => ({
          title: textRowTitle(item),
          value: item,
          description: textRowDescription(item),
          disabled: !item.deletable,
        }))
        api.ui.dialog.replace(() => (
          <DialogSelect
            title="批量删除：选择结束块（含）"
            placeholder="选择要删除到的文本块"
            options={restOptions}
            onSelect={(endOption) => {
              const end = endOption.value as TextCandidate
              const endIndex = indexOf(end)
              if (endIndex < startIndex || !end.deletable) {
                api.ui.toast({ variant: "info", message: "结束块必须在起始块之后且可删" })
                return
              }
              const range = all.slice(startIndex, endIndex + 1).filter((item) => item.deletable)
              if (range.length === 0) {
                api.ui.toast({ variant: "info", message: "该区间没有可删文本块" })
                return
              }
              confirmDeleteRange(api, sessionID, range)
            }}
          />
        ))
      }}
    />
  ))
}

const bar = (value: number, total: number, width = 10) => {
  const filled = total > 0 ? Math.round((value / total) * width) : 0
  const count = Math.max(0, Math.min(width, filled))
  return `${"█".repeat(count)}${"░".repeat(width - count)}`
}

type ContextValue =
  | { kind: "summary"; note: string }
  | { kind: "text"; item: TextCandidate }
  | { kind: "tool"; item: Candidate }

function showContext(api: TuiPluginApi) {
  const sessionID = currentSessionID(api)
  if (!sessionID) {
    api.ui.toast({ variant: "warning", message: "请在会话中打开" })
    return
  }
  const data = collect(api, sessionID)
  const messages = api.state.session.messages(sessionID)
  const last = [...messages]
    .reverse()
    .find((item): item is AssistantMessage => item.role === "assistant" && item.tokens?.output > 0)
  const used = last
    ? last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    : 0
  const totalChars =
    data.sum.user + data.sum.assistant + data.sum.reasoning + data.sum.tools + data.sum.files + data.sum.other
  const measured = totalChars / 4
  const total = Math.max(used, measured)
  const overhead = Math.max(0, total - measured)
  const rows = [
    {
      label: "系统/工具定义",
      value: overhead,
      note: "系统提示、工具 schema、权限规则等，不可删（差额估算）",
    },
    { label: "用户", value: data.sum.user / 4, note: "用户文本，可在明细中删除" },
    { label: "输出", value: data.sum.assistant / 4, note: "助手文本，可在明细中删除" },
    { label: "推理", value: data.sum.reasoning / 4, note: "推理内容不可删除" },
    { label: "工具输出", value: data.sum.tools / 4, note: "工具信息不可删除，可用 Ctrl+P 卸载/恢复" },
    { label: "文件", value: data.sum.files / 4, note: "文件信息不可删除" },
    { label: "其他", value: data.sum.other / 4, note: "其他信息不可删除" },
  ]
  const percent = (value: number) => (total > 0 ? Math.round((value / total) * 100) : 0)
  const options: Array<{ title: string; value: ContextValue; description?: string }> = [
    ...rows.map((row) => ({
      title: `${row.label} ${bar(row.value, total)} ${percent(row.value)}% · ${fmt(row.value)}`,
      value: { kind: "summary" as const, note: row.note },
      description: row.note,
    })),
    {
      title: "系统提示 · 不可删（API 未暴露大小）",
      value: { kind: "summary", note: "系统提示由运行时注入，API 未暴露，不能删除" },
      description: "运行时注入，不参与消息块删除",
    },
    {
      title: "权限规则 · 不可删（API 未暴露大小）",
      value: { kind: "summary", note: "权限规则由配置决定，不能从上下文删除" },
      description: "由配置决定，不参与消息块删除",
    },
    {
      title: "—— 用户/输出正文明细 ——",
      value: { kind: "summary", note: "历史正文可删；当前用户输入只读" },
      description: `删除前会备份到 ${backupDir()}/`,
    },
    ...data.texts.map((item) => ({
      title: `[${item.deletable ? "可删" : "不可删"}] ${item.role === "user" ? "用户" : "输出"} · ${fmt(item.size / 4)} · ${clip(item.preview, 28)}`,
      value: { kind: "text" as const, item },
      description: clip(`${metaText(item.created, item.importance, item.relevance)} · ${item.preview}`, 120),
    })),
    {
      title: "—— 工具信息明细（不可删除）——",
      value: { kind: "summary", note: "工具信息不可删除；用 Ctrl+P 的卸载/恢复管理" },
      description: "工具输出可卸载，但不是删除",
    },
    ...data.unload.map((item) => ({
      title: `[不可删] ${item.tool} · ${fmt(item.size / 4)} · ${importanceLabel(item.importance)}`,
      value: { kind: "tool" as const, item },
      description: clip(
        `${metaText(item.created, item.importance, item.relevance)} · ${item.title || item.preview}`,
        120,
      ),
    })),
  ]
  const visible = options.slice(0, 100)
  const DialogSelect = api.ui.DialogSelect
  const DialogConfirm = api.ui.DialogConfirm
  api.ui.dialog.replace(() => (
    <DialogSelect
      title={`上下文分布 (${fmt(total)} tokens${used > 0 ? "" : " 估算"} · ${countLabel(options.length)} 项)`}
      placeholder="搜索信息块（用户/输出可删）"
      options={visible}
      onSelect={(option) => {
        const value = option.value as ContextValue
        if (value.kind === "summary") {
          api.ui.toast({ variant: "info", message: value.note })
          return
        }
        if (value.kind === "tool") {
          api.ui.toast({ variant: "info", message: "工具信息不可删除；用 Ctrl+P 的卸载/恢复管理" })
          return
        }
        const item = value.item
        if (!item.deletable) {
          api.ui.toast({ variant: "info", message: "当前用户输入不可删除" })
          return
        }
        api.ui.dialog.replace(() => (
          <DialogConfirm
            title="永久删除正文"
            message={`${item.role === "user" ? "用户" : "助手"}正文 · 不可恢复 · ${metaText(item.created, item.importance, item.relevance)}\n\n${clip(item.preview, 300)}\n\n删除后无法还原（会先备份到 ${backupDir()}/）。`}
            onConfirm={() => {
              api.ui.dialog.clear()
              void removeText(api, sessionID, item)
            }}
            onCancel={() => api.ui.dialog.clear()}
          />
        ))
      }}
    />
  ))
}

const tui: TuiPlugin = async (api, options) => {
  const disabled = [] as string[]
  for (const id of [CONTEXT_ID, FOOTER_ID]) {
    const item = api.plugins.list().find((entry) => entry.id === id)
    if (!item?.active) continue
    const ok = await api.plugins.deactivate(id).catch(() => false)
    if (ok) disabled.push(id)
  }
  api.lifecycle.onDispose(async () => {
    for (const id of disabled) await api.plugins.activate(id).catch(() => undefined)
  })

  const [tick, setTick] = createSignal(0)
  let timer: ReturnType<typeof setTimeout> | undefined
  const bump = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      setTick((value) => value + 1)
    }, 300)
  }
  const unsubs = [
    api.event.on("message.updated", bump),
    api.event.on("message.removed", bump),
    api.event.on("message.part.updated", bump),
    api.event.on("message.part.removed", bump),
    api.event.on("session.updated", bump),
  ]
  api.lifecycle.onDispose(() => {
    if (timer) clearTimeout(timer)
    for (const unsubscribe of unsubs) unsubscribe()
  })

  const top = (_ctx: unknown, props: { session_id: string }) => (
    <box gap={1}>
      <Quota api={api} session_id={props.session_id} options={options} />
      <Files api={api} session_id={props.session_id} tick={tick} />
    </box>
  )
  const render = (_ctx: unknown, props: { session_id: string }) => (
    <box gap={1}>
      <Panel api={api} session_id={props.session_id} tick={tick} />
      <Footer api={api} session_id={props.session_id} />
    </box>
  )
  const content = (_ctx: unknown, props: { session_id: string }) => (
    <box gap={1}>
      <Quota api={api} session_id={props.session_id} options={options} />
      <Files api={api} session_id={props.session_id} tick={tick} />
      <Panel api={api} session_id={props.session_id} tick={tick} />
    </box>
  )
  const footer = !api.plugins.list().find((entry) => entry.id === FOOTER_ID)?.active
  api.slots.register({
    order: footer ? 50 : 1000,
    slots: footer ? { sidebar_content: top, sidebar_footer: render } : { sidebar_content: content },
  } as Parameters<typeof api.slots.register>[0])

  api.keymap.registerLayer({
    commands: [
      {
        name: "context.unload",
        title: "卸载上下文段落 (Unload)",
        category: "Context",
        namespace: "palette",
        run() {
          showUnload(api)
        },
      },
      {
        name: "context.restore",
        title: "恢复已卸载输出 (Restore)",
        category: "Context",
        namespace: "palette",
        run() {
          showRestore(api)
        },
      },
      {
        name: "context.delete",
        title: "永久删除正文段落 (Delete text)",
        category: "Context",
        namespace: "palette",
        run() {
          showDelete(api)
        },
      },
      {
        name: "context.delete.range",
        title: "批量删除连续正文 (Delete range)",
        category: "Context",
        namespace: "palette",
        run() {
          showDeleteRange(api)
        },
      },
      {
        name: "context.reset",
        title: "恢复内置侧栏 (Reset sidebar)",
        category: "Context",
        namespace: "palette",
        run() {
          void resetSidebar(api)
        },
      },
    ],
    bindings: [
      ...api.tuiConfig.keybinds.gather("context.unload", ["context.unload"]),
      ...api.tuiConfig.keybinds.gather("context.restore", ["context.restore"]),
      ...api.tuiConfig.keybinds.gather("context.delete", ["context.delete"]),
      ...api.tuiConfig.keybinds.gather("context.delete.range", ["context.delete.range"]),
      ...api.tuiConfig.keybinds.gather("context.reset", ["context.reset"]),
    ],
  })

  const unregister = api.command?.register(() => [
    {
      title: "上下文分布 (Context)",
      value: "context.view",
      category: "Context",
      slash: { name: "context", aliases: ["ctx"] },
      onSelect: () => showContext(api),
    },
  ])
  if (unregister) unsubs.push(unregister)
}

const plugin: TuiPluginModule & { id: string } = {
  id: "tui-context-panel",
  tui,
}

export default plugin
