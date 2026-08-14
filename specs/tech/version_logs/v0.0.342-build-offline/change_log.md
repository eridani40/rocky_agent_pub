# v0.0.342 tech change log — 打包离线化（build-dmg.sh 固定联网点根治）

> 对应需求：`reqs/[working] v0.0.342.build-offline-packaging.md`。
> 纯工具链改动，无用户可感知变化 → 跳 PRD（reqs 边界声明）。

## 根因

老板 2026-08-12 22:03 反馈：**每次打包都卡在网络，不联网就打包不了**（非偶发）。electron zip / node-gyp headers / dmg-builder 缓存均存在，但打包仍每次联网——存在未走缓存的固定联网点。

排查确认两个固定联网点：

1. **electron-builder CLI 启动即联网**：`cli-util.js checkIsOutdated → simple-update-notifier` 每次启动查 npm registry，弱网/断网下卡住。
2. **unpack 必经 @electron/get 下载**：electron-builder 默认 unpack **总走 `@electron/get` 下载 electron zip——即便本地 `node_modules/electron/dist` 已存在**；且 `@electron/get` 对缓存 zip 仍**每次下载 `SHASUMS256.txt` 做校验**（cacheMode: Bypass）→ 每次打包必联网。

## 修复（v0.0.342）

`scripts/build-dmg.sh` 三处改动（coder ec700d8a5 + code-review 修复 12d8d3841）：

1. **`export NO_UPDATE_NOTIFIER=1`**（脚本顶部）：禁用 electron-builder CLI 每次启动的 update-notifier 联网检查。
2. **③ 前本地 electron dist 确保**：检查 `app/electron/node_modules/electron/dist/version`，缺失则跑 electron `install.js` 本地解压（**幂等**；命中 `~/Library/Caches/electron` 缓存 zip **零联网**）。install.js 读**小写** `electron_config_cache`（npm config 风格，install.js:46）；显式传默认缓存路径（与 @electron/get env-paths 默认 `~/Library/Caches/electron` 一致）。`|| true`：`set -e` 下 install.js 失败不提前退出，由二次检查 `[ ! -f dist/version ]` 打印可操作 ERROR（exit 3）。
3. **`--config.electronDist="$ELECTRON_DIST_ABS"`**（本地已解压 dist 绝对路径）：electron-builder 走「custom unpacked Electron distribution」**copyDir 分支，完全跳过下载/SHASUMS 校验**。

### 边界与铁律落实情况

- 不动 prod.env / 签名逻辑 / 产物结构 ✓
- 断网失败不静默：dist 缺失且无缓存 → exit 3 明确报错 + 可操作指引（先有网跑一次 `bun install`）✓
- 全新机器需先有网跑一次 `bun install`（产生 dist/缓存）后断网可打包 ✓

## 关键文件变更

| 文件 | 变更 |
|---|---|
| `scripts/build-dmg.sh` | ① 顶部 `export NO_UPDATE_NOTIFIER=1`；② ③ 前 ELECTRON_DIST_DIR 检查 + install.js 兜底（`electron_config_cache` 小写 + `\|\| true`）；③ electron-builder 补 `--config.electronDist` |

## 验证结论

- **断网实测 2 次零联网**：禁外网环境跑 build-dmg.sh 成功产出 dmg（离线链路完整走通）
- **产物差异核实通过**：离线产物与在线产物一致性核实无差异
- code-review 2 Minor 修复（electron_config_cache 小写 env + install.js 失败 `|| true` 保错误提示）已合入

## doc 同步（doc-modifier2，合并前完成）

- `specs/tech/app/package/[P0]packaging_toolchain.md §3.10`：**离线打包**章节（新增）——两个固定联网点根因 + electronDist 本地化方案 + NO_UPDATE_NOTIFIER + install.js 幂等兜底 + 断网/弱网使用说明 + `ELECTRON_CONFIG_CACHE`（小写）环境变量
- `specs/tech/app/package/[P0]packaging_toolchain.md §4.2`：流程示意 ⑤ 拆出 electron-dist 离线准备步 + ⑥ electron-builder 补 electronDist
- `specs/tech/app/package/[P0]packaging_toolchain.md §5`：边界表归属补离线打包
- `specs/tech/app/envs/[P0]scripts.md §3.3`：build-dmg.sh 动作补离线准备 + electronDist
- `specs/tech/app/package/log.md`：KB log v0.0.342 块（含编号偏差说明）
- `specs/tech/app/package/index.md`：④ 设计原则补第 16 条（离线打包）

> **编号偏差说明**：code-reviewer 观察项与派单原文说补「§3.6」，但 `packaging_toolchain.md` 的 §3.6 已被 runtime-config.json 占用（3.6~3.9 全存在，build-dmg.sh 注释亦确认「§3.6 为 runtime-config.json」）——离线打包章节实际追加为 **§3.10**（不重排已有编号，避免破坏 §3.6~3.9 既有交叉引用）。
