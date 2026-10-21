# opencode-context-panel

OpenCode TUI 的上下文管理插件：在侧栏展示 token、缓存命中、成本与上下文组成，并支持按**消息块/文本块**卸载、恢复或删除上下文内容。

> 当前发布线面向 OpenCode `1.19.x`。OpenCode v2 的插件 API 有破坏性变更，本包尚未迁移。

## 功能

- 侧栏 `Context` 面板：上下文 token、占用比例、缓存命中、单轮/会话成本、组成估算。
- 侧栏 `Go 配额`：5h/周/月百分比、重置倒计时、使用速度（%/h）和条形图。
- 侧栏修改文件列表：显示当前会话改动文件，点击标题在改动量/时间/大小排序间切换。
- 免费额度倒计时：按 UTC 00:00 估算下一次重置（Free 模型没有官方查询 API）。
- 工具输出管理：按占用排序卸载历史工具输出，可随时恢复；卸载只影响上下文，不删除原始数据。
- 文本块管理：`/context`（别名 `/ctx`）查看分布明细；可按指定 `messageID + partID` 删除历史用户文本或助手输出。
- 安全限制：当前用户输入只读；系统提示、权限规则、工具/推理/文件块不可删除。
- 删除前自动备份到本地目录，删除失败不会继续。

## 安装

### 从 npm

```bash
opencode plugin opencode-context-panel -g
```

或在全局 `~/.config/opencode/tui.json` 中手动加入：

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-context-panel"]
}
```

### 本地开发

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/opencode-context-panel/src/tui.tsx"]
}
```

## 使用

- 点击侧栏 `Context`：打开上下文分布。
- `/context` 或 `/ctx`：打开上下文分布与文本块明细。
- `Ctrl+P` 搜索 `Context`：
  - `卸载上下文段落`
  - `恢复已卸载输出`
  - `永久删除正文段落`
  - `批量删除连续正文`：选起始块和结束块，一次删除区间内的可删块
  - `恢复内置侧栏`

## Go 配额与自动切换

配额面板调用 `https://opencode.ai/zen/go/v1/usage`，读取 `rolling`（5h）、`weekly`、`monthly` 的百分比和重置时间。API key 优先取 `opencode-go` provider 的 key，取不到时读环境变量 `OPENCODE_GO_API_KEY` 或 `OPENCODE_API_KEY`。

可选配置（`tui.json` 使用 tuple 形式）：

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "/absolute/path/to/opencode-context-panel/src/tui.tsx",
      {
        "fallbackModel": "provider/model-id",
        "autoSwitch": true,
        "pollMs": 120000
      }
    ]
  ]
}
```

- `fallbackModel`：Go 任一窗口 `status != "ok"` 或达到 `100%` 时切换到的模型，格式 `providerID/modelID`。
- `autoSwitch`：默认在配置了 `fallbackModel` 时开启；设为 `false` 可关闭。
- `pollMs`：配额刷新间隔，默认 120000（2 分钟）；最低 30 秒。
- 自动切换是单向的：只负责“Go 用尽后切走”，不会在配额重置后自动切回。
- 免费模型没有官方 usage API，面板只能显示按 UTC 00:00 估算的重置倒计时，不能判断免费额度是否已用尽，因此不会基于免费额度自动切换。

## 赞助

插件免费且采用 MIT 许可。如果它帮你省了时间，欢迎自愿赞助，不影响任何功能。

- 中国大陆：支付宝收款码（下图）
- 海外：支付宝国际版可用，但需要安装 Alipay，转化率较低；更推荐 Ko-fi 或 PayPal（可开 issue 联系）

![支付宝收款码](https://raw.githubusercontent.com/renyuan000/opencode-context-panel/main/assets/alipay.png)

> 收款码会公开展示，请自行遮挡真实姓名等敏感信息。赞助是赠与，不是购买，不附带额外授权或支持承诺。

## 数据与隐私

删除文本块前，插件会把原文写入本地纯文本备份：

- 默认：`~/.local/share/opencode/context-backups/`
- 覆盖：设置环境变量 `OPENCODE_CONTEXT_BACKUP_DIR`

备份包含会话原文，请自行管理访问权限与保留周期。插件不会把备份上传到网络。

删除调用 OpenCode 的 `part.delete({ sessionID, messageID, partID })`，只删除指定文本 part，不会删除整条消息或会话。删除不可恢复，只能从上述备份中人工找回。

## 已知限制

- 依赖 OpenCode 内置侧栏插件 ID：`internal:sidebar-context`、`internal:sidebar-footer`。OpenCode 升级后 ID 变化可能导致侧栏替换失效。
- `/context` 使用 v1 的 `api.command.register`；该 API 在 OpenCode v2 已标记移除。
- token 组成中的“系统/工具定义”是差额估算，不是运行时精确值。
- Go 配额接口不是 OpenCode 稳定插件 API，服务端变更可能导致面板失效；速度需要至少两次采样，刚启动时没有速率。
- 自动切换依赖 `/api/session/{sessionID}/model`，失败时只提示，不会重试。
- 免费额度重置时间按 UTC 00:00 估算，不是官方返回值。
- 尚未提供自动化测试；发布前请至少运行 `npm run typecheck`。

## 开发

```bash
npm install
npm run typecheck
npm pack --dry-run
```

## License

MIT
