#!/usr/bin/env bash
# 运行全部测试：单测 → mock AT 套件 → 类型检查
# （real 集成测试需 ZCode CLI，单独运行：node --test packages/e2e/test/real/*.test.ts）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 类型检查 =="
npx tsc --noEmit -p packages/gateway
npx tsc --noEmit -p packages/e2e

echo "== 单元测试 =="
node --test packages/gateway/test/*.test.ts

echo "== AT 验收套件（mock）=="
node --test --test-timeout=30000 packages/e2e/test/mock/*.test.ts

echo "全部通过 ✓"
