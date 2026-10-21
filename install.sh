#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/renyuan000/opencode-context-panel.git"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
CONFIG_FILE="${OPENCODE_TUI_CONFIG:-$CONFIG_DIR/tui.json}"
TARGET="${CONFIG_DIR}/packages/opencode-context-panel"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/package.json" ] && [ -f "$SCRIPT_DIR/src/tui.tsx" ]; then
  TARGET="$SCRIPT_DIR"
else
  mkdir -p "$(dirname "$TARGET")"
  if [ -d "$TARGET/.git" ]; then
    git -C "$TARGET" pull --ff-only || echo "更新失败，继续使用当前版本。"
  elif [ -d "$TARGET" ]; then
    echo "目录已存在但不是 git 仓库：$TARGET" >&2
  else
    git clone "$REPO_URL" "$TARGET"
  fi
fi

cd "$TARGET"

if command -v npm >/dev/null 2>&1; then
  npm install --no-audit --no-fund
elif command -v bun >/dev/null 2>&1; then
  bun install
else
  echo "需要 npm 或 bun 来安装依赖。" >&2
  exit 1
fi

ENTRY="$TARGET/src/tui.tsx"

if command -v python3 >/dev/null 2>&1; then
  python3 - "$CONFIG_FILE" "$ENTRY" <<'PY'
import json
import os
import shutil
import sys
import time

config_path, entry = sys.argv[1:3]
if os.path.exists(config_path):
    try:
        with open(config_path, encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        backup = f"{config_path}.bak.{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.copy2(config_path, backup)
        print(f"无法解析 {config_path}（可能含注释），已备份到 {backup}")
        print("请手动把下面这一项加入 plugin 数组：")
        print(json.dumps(entry, ensure_ascii=False))
        sys.exit(2)
else:
    data = {"$schema": "https://opencode.ai/tui.json"}

if not isinstance(data, dict):
    raise SystemExit(f"{config_path} 不是 JSON 对象")

plugins = data.get("plugin")
if not isinstance(plugins, list):
    plugins = []

plugins = [item for item in plugins if item != "opencode-context-panel"]
if entry not in plugins:
    plugins.append(entry)
data["plugin"] = plugins

if os.path.exists(config_path):
    backup = f"{config_path}.bak.{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(config_path, backup)

directory = os.path.dirname(os.path.abspath(config_path))
os.makedirs(directory, exist_ok=True)
with open(config_path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, ensure_ascii=False, indent=2)
    handle.write("\n")

print(f"已更新 {config_path}")
print(f"插件路径: {entry}")
PY
else
  echo "没有 python3，无法自动修改 $CONFIG_FILE。请手动加入："
  printf '  "plugin": ["%s"]\n' "$ENTRY"
fi

echo
echo "安装完成。重启 OpenCode 生效。"
