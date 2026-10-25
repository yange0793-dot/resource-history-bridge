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

if [[ -z "${RHB_UPSTREAM:-}" ]]; then
  printf '%s' '上游 API Base URL（例如 https://api.example.com/v1，不要填密钥）: '
  if ! IFS= read -r RHB_UPSTREAM || [[ -z "$RHB_UPSTREAM" ]]; then
    printf '%s\n' '没有提供上游地址，已退出。' >&2
    exit 1
  fi
fi

if [[ -z "${RHB_UPSTREAM_PROTOCOL:-}" ]]; then
  printf '%s\n' 'Messages 上游协议：responses = 转为 Responses（AgentRouter 目标）；passthrough = 原样转发。'
  printf '%s' '选择 responses / passthrough [responses]: '
  if ! IFS= read -r RHB_UPSTREAM_PROTOCOL; then
    printf '%s\n' '无法读取协议选择，已退出。' >&2
    exit 1
  fi
  RHB_UPSTREAM_PROTOCOL="${RHB_UPSTREAM_PROTOCOL:-responses}"
fi
if [[ "$RHB_UPSTREAM_PROTOCOL" != 'responses' && "$RHB_UPSTREAM_PROTOCOL" != 'passthrough' ]]; then
  printf '%s\n' 'RHB_UPSTREAM_PROTOCOL 只能为 responses 或 passthrough。' >&2
  exit 1
fi

export RHB_UPSTREAM RHB_UPSTREAM_PROTOCOL
printf '%s\n' '默认透传客户端原有密钥；本脚本不询问或保存密钥，不修改客户端配置。' '桥将在前台运行。按 Ctrl+C 停止监听。'
exec "$NODE_BIN" "$ROOT_DIR/cli.js"
