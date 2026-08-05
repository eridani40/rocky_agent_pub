#!/bin/bash
# reset-dev-plugin-order.sh — v0.0.18 一次性运维脚本
# 参考: design §5.2 / §5.3
#
# 用途：重置 dev 环境 plugin_policy 中的脏 order 字段（v0.0.17 之前的 priority-based
#       脏值），保留 enabled/config/exclusive。重置后所有 impl 无 order record →
#       inventory 默认补位算法按 manifest 登记序排 1..n。
#
# soft-delete 约定（项目 MEMORY）：不 rm，改 mv 到已 gitignore 的 soft_deleted/。
# 先 cp 整目录备份，再原地改 record；空 record（只剩 order 字段被删后）→ mv 到 soft_deleted。
#
# 用法：
#   bash scripts/reset-dev-plugin-order.sh            # 默认 dev 数据根
#   bash scripts/reset-dev-plugin-order.sh /path/to   # 自定义数据根
set -e

DATA_ROOT="${1:-$HOME/.rocky_agent_dev}"
IMPL_DIR="$DATA_ROOT/plugin_policy/impl/plugin_policy"
BACKUP_DIR="$DATA_ROOT/soft_deleted/v0.0.18-plugin-sorting-reset"
TS=$(date +%Y%m%d-%H%M%S)

if [ ! -d "$IMPL_DIR" ]; then
  echo "[reset] impl 目录不存在: $IMPL_DIR （无 dev 数据，无需重置）"
  exit 0
fi

echo "[reset] 数据根: $DATA_ROOT"
echo "[reset] impl 目录: $IMPL_DIR"

# 1. 备份（先 cp 整目录，保留审计）
mkdir -p "$BACKUP_DIR"
cp -r "$IMPL_DIR" "$BACKUP_DIR/impl-bak-$TS"
echo "[reset] 已备份到: $BACKUP_DIR/impl-bak-$TS"

# 2. 逐条处理：删 data.order；空 record 则 mv 到 soft_deleted
RESET_COUNT=0
DELETE_COUNT=0
for f in "$IMPL_DIR"/*.json; do
  [ -f "$f" ] || continue
  # 用 python3 安全改 JSON（保留其他字段）
  python3 - "$f" "$BACKUP_DIR" <<'PY'
import json, sys, os, shutil
path = sys.argv[1]
backup_dir = sys.argv[2]
with open(path) as fh:
    rec = json.load(fh)
data = rec.get('data', {})
if not isinstance(data, dict):
    print(f"[reset] skip (data 非 object): {path}")
    sys.exit(0)
if 'order' not in data:
    sys.exit(0)  # 无 order 字段，不动
# 删 order 字段
del data['order']
rec['data'] = data
# 删后 data 是否空对象
if not data:
    # 空 record → mv 到 soft_deleted（保留审计）
    dest = os.path.join(backup_dir, os.path.basename(path))
    shutil.move(path, dest)
    print(f"[reset] DELETE (空 record → soft_deleted): {os.path.basename(path)}")
else:
    with open(path, 'w') as fh:
        json.dump(rec, fh, indent=2, ensure_ascii=False)
    print(f"[reset] STRIP order (保留 {list(data.keys())}): {os.path.basename(path)}")
PY
done

echo "[reset] 完成。备份在 $BACKUP_DIR/impl-bak-$TS"
echo "[reset] 重置后所有 impl 无 order record → inventory 按 manifest 登记序补位 1..n"
