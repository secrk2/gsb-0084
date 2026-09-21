#!/bin/sh
set -e

echo "[jimu] 建表迁移…"
node scripts/ensure-schema.js

COUNT=$(node scripts/count-apps.js)
if [ "$COUNT" = "0" ]; then
  echo "[jimu] 数据库为空，写入种子数据…"
  node src/seed.js
else
  echo "[jimu] 已有 ${COUNT} 个应用，跳过种子数据"
fi

echo "[jimu] 启动后端服务…"
exec node src/server.js
