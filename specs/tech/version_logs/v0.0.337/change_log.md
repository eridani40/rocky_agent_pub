# v0.0.337 tech change log — update-app.sh 重启白屏修复

> 对应需求：`reqs/[working] v0.0.337.md`（老板实测反馈：update-app.sh 更新后重启必白屏；2026-08-12 13:5x 派单）。
> commit：`94b1249a5`（T1 修复）+ `8fe0b9caa`（req 文档）。

## 根因（老板判断 + 代码实证）

update-app.sh 的链路 `kill → mount dmg → cp 替换 .app → detach → open` 中：
- `cp -R` 替换 `.app`（~290MB）后**立即 `open`**，macOS 可能还在校验/写盘未完成（code signature / Gatekeeper 校验、文件句柄未 flush）→ 启动读到不完整 asar/资源 → 白屏。
- `detach` 与 `open` 时序、cp 大文件未同步落盘是同一类问题：**文件未落盘就启动**。

## 修复（commit 94b1249a5，scripts/update-app.sh +7 -1）

- 在 `hdiutil detach` 之后、`open` 之前新增：
  ```bash
  # ── 7. 等待文件落盘（修复白屏：cp 290MB 后立即 open 会读到未写完的文件） ──
  log "waiting for files to settle (sync + 3s)..."
  sync
  sleep 3
  ```
- `sync` 强制文件系统落盘（flush 脏页），`sleep 3` 给 macOS 校验/索引留余量；随后 `open "$APP_PATH"` 重启。

> 佐证：老板 0.0.335 更新时加了 `sleep 15 + sync` 侥幸没复现——`sync` 是必要动作，`sleep` 是余量。

## 边界（req 明确）

- ✅ update-app.sh 更新后启动 app 不白屏，链路时序根治
- ❌ 不动 app 自身启动逻辑、不动打包 build-dmg.sh（根因不指向它）、不扩其他

## 文档同步

- **`specs/tech/app/envs/[P0]scripts.md`**：`update-app.sh` 补入脚本契约——§1 概述脚本清单 + §2 契约总表加第 4 行（无 env source）+ **§3.4 新增 update-app.sh 契约**（7 步动作：缓冲 2s → 杀 app → 挂载 dmg → 替换 .app → detach → **sync + 3s 等落盘** → open；nohup 脱离运行边界；`[v0.0.337]` 修复注记）+ §5 示例 + §6 边界表（三脚本→四脚本）；frontmatter updated 2026-08-12。
- **`specs/tech/app/envs/log.md`**：v0.0.337 变更记录条目。
- 注：`scripts/` 下原契约只列三脚本（unit-test/run-dev/build-dmg），`update-app.sh` 此前无 spec——本版补入并文档化其修复。
