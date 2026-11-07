#!/usr/bin/env bash
# 初始化 zremote 沙箱：隔离的测试工作区（真实后端的测试会话全部落在该目录）
set -euo pipefail

SANDBOX="${ZREMOTE_SANDBOX:-$HOME/zremote-sandbox}"
mkdir -p "$SANDBOX/demo-app"
cd "$SANDBOX/demo-app"

[ -d .git ] || git init -q 2>/dev/null || true

cat > README.md <<'EOF'
# zremote demo-app

ZCode Remote WSL 模拟的测试工作区（不含敏感信息）。
真实后端（ZREMOTE_BACKEND=real）的测试会话统一在该目录创建，
与用户既有会话隔离。
EOF

echo "沙箱就绪: $SANDBOX/demo-app"
