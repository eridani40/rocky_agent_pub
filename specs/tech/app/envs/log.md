---
type: log
title: Envs KB 变更记录
updated: 2026-07-10
---

# Envs KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-08-10 · v0.0.317

- 新增 §4.8 **dev 模式 Electron `APP_NAME` 进程隔离**：dev 模式（`shouldStartBackend=false`）在 `app.whenReady()` 前显式调 `app.setName(APP_NAME)`，让 macOS 认为 dev 与 packaged 是不同 app（如 `rocky_agent_dev` vs `rocky_agent`），避免 dev 启动影响 prod 窗口（白屏）。复用共通键 `APP_NAME`，无新增 env 键。→ `environments.md §4.8`。

## 2026-07-10 · v0.0.108

- `prod.env` schema 三分类重组 + 删 `APP_VERSION`（版本号改由根 `package.json` version 派生，见 `../package/`）：① 进包白名单（`API_PORT`/`DATA_DIR`/`APP_NAME`/`APP_ENV`/`LOG_LEVEL`/`HEALTH_ENDPOINT`）② 仅 build 期（`WEB_PORT`/`BUILD_OUT_DIR`）③ 密钥留空（`APPLE_*`/`CSC_*`）。→ `environments.md §3.4/§3.5`。
- `HEALTH_ENDPOINT` 归入**共通键**（test/dev/prod 三份 `.env` 均有；原误标 test 专有）。→ `environments.md §3.1`。
- `build-dmg.sh` 契约更新：版本源改根 `package.json`、前置校验改（version 无效 exit 2 + prod.env 关键字段校验，签名凭证可空跳过）。→ `scripts.md §3.3/§4.4`。
- 新增 §4.7 **`DATA_DIR` 字面 `~` 单一展开权威（BUG-004）**：`DATA_DIR` 存字面 `~/`（跨机可移植），`~` 展开唯一权威 = `config.resolveDataDir`（`expandTilde` 按运行用户 home）；所有入口（dev/CLI `index.ts` + packaged 启动桥 `backend-bootstrap`）都复用它，禁各自拼接字面 `~`。否则 packaged cwd=`/` 下 `mkdirSync('/~/...')` EACCES → 全部 HTTP 500。→ `environments.md §4.7` + `../package/[P0]package_structure.md §4.3`。

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起）+ 本 `log.md`。
- `[P0]environments.md` / `[P0]scripts.md` 加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文已是现状形态（无 inline 版本噪声需清理）。
