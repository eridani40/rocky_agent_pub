---
type: spec
title: Builtin Resources — 内置资源（skills + squad-templates）打包固化链路
priority: P0
updated: 2026-08-10
---

# Builtin Resources 打包固化

> **一句话**：builtin skills 和 squad-templates 的唯一权威源 = `app/plugins/builtins/`。改了源码 → 重新打包 → 启动时自动覆盖本地。不打包不生效。

## ① 问题定义

内置资源（skills、squad-templates）有三份副本：

| 位置 | 角色 | 能否直接改 |
|------|------|-----------|
| `app/plugins/builtins/` | **源码（唯一权威源）** | ✅ 改这里 |
| `app/plugins/dist/builtins/` | 编译产物（.gitignore，build-plugins.ts 生成） | ❌ 会被覆盖 |
| `~/.rocky_agent_prod/squad-templates/` | 运行时副本（bootstrap 覆盖） | ❌ 启动时被 builtin 覆盖 |

**踩坑根因**：只改运行时副本（`~/.rocky_agent_prod/`），没改源码 → 打包时 build-plugins.ts 从旧源码生成 dist → asar 里是旧的 → 启动覆盖到本地还是旧的。

## ② 完整链路（源码 → 用户目录）

```
app/plugins/builtins/squad-templates/{slug}/     ← 源码（改这里）
        │
        │  build-plugins.ts ②copyResources()
        │  fs.cpSync(builtins/squad-templates → dist/builtins/squad-templates)
        ↓
app/plugins/dist/builtins/squad-templates/{slug}/  ← 编译产物（.gitignore）
        │
        │  electron-builder.yml ⑥files.extraResources:
        │  from: ../plugins/dist → to: node_modules/@app/plugins
        ↓
app.asar 内 node_modules/@app/plugins/builtins/squad-templates/{slug}/
        │
        │  app 启动 → squad-templates-bootstrap.ts
        │  syncBuiltinSquadTemplates(builtinsDir, dataDir)
        │  manifest.builtin === true → 整体复制（强制覆盖同名）
        ↓
~/.rocky_agent_prod/squad-templates/{slug}/        ← 运行时（用户创建 squad 时读这里）
```

内置 skills 同理：`builtins/skills/` → `dist/builtins/skills/` → asar → 运行时加载。

## ③ build-plugins.ts 关键逻辑

**入口**：`bun run scripts/build-plugins.ts`（build-dmg.sh ② 段自动调）

**流程**：
1. `fs.rmSync(DIST)` — 全量清空 dist（无增量，防陈旧产物）
2. stage 拷贝 builtins → 临时目录 → 改写 server import → bun build .cjs bundle
3. `copyResources()`：拷贝非编译资源到 dist
   - `plugin.json` → `dist/builtins/{id}/plugin.json`
   - `scopes/*.yaml` → `dist/scopes/`
   - `session-types/*.yaml` → `dist/session-types/`
   - `skills/**` → `dist/builtins/skills/`（递归 cpSync）
   - **`squad-templates/**` → `dist/builtins/squad-templates/`（递归 cpSync）**
4. `verifyProducts()` — 校验产物完整性（缺则 throw）

**关键约束**：
- dist 是编译产物，**.gitignore 忽略**，不入库
- 每次全量重建，不从增量同步——**源码改了就一定进 dist**

## ④ Bootstrap 同步逻辑

**入口**：`app/server/src/bootstrap/squad-templates-bootstrap.ts`
**触发时机**：bootstrap plugin phase 之后、store phase 之前

```
syncBuiltinSquadTemplates(builtinsDir, dataDir):
  for each slug in builtins/squad-templates/:
    读 manifest.json
    if manifest.builtin === true:
      copyDirRecursive(src, ~/.rocky_agent_prod/squad-templates/{slug}/)  ← 强制覆盖
    else:
      跳过（用户自定义模板不碰）
```

**asar 兼容**：packaged 模式下 asar 是虚拟文件系统，`cpSync({recursive:true})` 静默失败。用手动递归 `readdirSync` + `readFileSync → writeFileSync` 逐文件复制。

**覆盖语义**：
- `builtin: true` 模板 → **每次启动强制覆盖**本地（保证 builtin 最新版生效）
- `builtin: false` 模板 → **永不覆盖**（用户自定义保护）
- 用户改 builtin 模板的本地副本 → 下次启动被冲掉（by design）

## ⑤ 更新 builtin 资源的 SOP

**场景**：更新 webapp-dev-team 模板内容（如加 INITIALIZED 配置块）

```
步骤 1：改源码
  app/plugins/builtins/squad-templates/webapp-dev-team/  ← 改这里

步骤 2：commit
  git add app/plugins/builtins/squad-templates/
  git commit

步骤 3：打包
  bash scripts/build-dmg.sh
  （build-plugins.ts 自动从源码重新生成 dist → electron-builder 打进 asar）

步骤 4：安装/更新
  安装新 dmg（或 update-app.sh）→ 启动 → bootstrap 自动覆盖本地

验证：
  grep "INITIALIZED" ~/.rocky_agent_prod/squad-templates/webapp-dev-team/AGENTS.md
  → 应输出匹配行
```

**禁止**：
- ❌ 直接改 `~/.rocky_agent_prod/squad-templates/`（启动时被覆盖）
- ❌ 直接改 `app/plugins/dist/`（编译产物，下次 build-plugins 被清空）
- ❌ 手动 cp 到 dist 绕过 build-plugins（可能遗漏 asar 映射）

## ⑥ electron-builder 映射

`app/electron/electron-builder.yml` 关键配置：

```yaml
files:
  - from: ../plugins/dist
    to: node_modules/@app/plugins     # dist → asar 内映射目标
asarUnpack:
  # builtin skills references 需文件系统真实路径（cp/bash 访问）
  - 'node_modules/@app/plugins/builtins/skills/*/references/**/*'
```

**注意**：squad-templates 不需要 asarUnpack（bootstrap 用 readFileSync 逐文件读取，asar 内可读）。skills 的 `references/` 需要 asarUnpack（executor 直接 cp/bash 执行脚本，需真实文件路径）。

## ⑦ 检查清单（打包前）

- [ ] `app/plugins/builtins/` 源码是最新版（非 dist、非本地副本）
- [ ] `manifest.json` 的 `builtin: true`
- [ ] 新增 skill 的 `references/` 如有脚本，已加到 `electron-builder.yml` asarUnpack
- [ ] `build-plugins.ts` 的 `copyResources()` 覆盖了新资源类型（如新增非 plugin 资源目录）
