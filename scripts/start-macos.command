#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

if ! NODE_BIN="$(command -v node)"; then
  printf '%s\n' '未找到 Node.js。请安装 Node.js 18 或更新版本，并确保 node 在 PATH 中。' >&2
  exit 1
fi
if ! NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"; then
  printf '%s\n' '无法运行 Node.js。请检查本机安装。' >&2
  exit 1
fi
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 18 )); then
  printf '%s\n' '需要 Node.js 18 或更新版本。' >&2
  exit 1
fi

printf '%s\n' '默认透传客户端原有密钥；本脚本不询问或保存密钥，不修改客户端配置。' '桥将在前台运行。按 Ctrl+C 停止监听。'
exec "$NODE_BIN" "$ROOT_DIR/cli.js"
