---
type: spec
title: Derive Academy 预检 + 同名裁决机制
priority: P1
status: active
updated: 2026-08-01
since: v0.0.233
---

# Derive Academy 预检 + 同名裁决机制

> 定位：v0.0.233 把 derive_academy 从「一次性自动 copy + 同名覆盖」升级为「继承预检 → 同名裁决 → 执行」三段。本文件只描**预检算法 + 裁决语义 + seed conditional copy 算法 + 补偿安全不变量**——是 `[P1]squad_derive.md` 的机制补遗，不取代其总语义（派生单向 / process 不可派生 / academySource 与 deriveFrom 互斥等不变量沿用）。
>
> 边界：本文件不管 academy 训练引擎（用 `version.workspaceDir` 独立目录树）/ derive mode（从 mate 派生，配置继承不拷贝 ws）/ AGENTS.md 注入语义（v0.0.232 既定）。
>
> 落点（v0.0.232 重映射后，本版本不变）：学生 `AGENTS.md` → `squads/{sid}/.rocky/agents/{memberName}-{memberId}.md`（member 私有个人差异）；学生 `.rocky/skills/**` → `squads/{sid}/.rocky/skills/`（团队盘，全队共享）；学生 `.rocky/memory/**` → `squads/{sid}/.rocky/memory/`（团队盘 group scope，全队共享）。

## 1. 现状与问题（v0.0.232 后浮现）

`seedMemberWorkspaceFromVersion`（`app/server/src/services/member-academy-bridge.ts`）现状用 `copyDirTracking(src, dst, written)` **全量复制** `.rocky/skills` + `.rocky/memory` 到团队盘，`copyDirRecursive` 落点同名文件/目录**后者覆盖前者**。

多个 member 各自从不同学生派生、带同名 skill/memory 时，后者**静默覆盖**前者，用户无感知；学生 memory 直接变团队共享记忆可能污染其他 mate 行为。本版本升级为预检 + 裁决 + 执行。

## 2. 预检（POST /squad/:id/member/derive-academy/preview）

### 2.1 算法

```
input: { squadId, classroomId, studentId, versionId }

1. resolveAcademyDeriveIdentity(deps, input)
   — 校验三字段必填 / 与 deriveFrom 互斥 / classroom 存在 / version formal+active
   — 失败 throw InvalidAcademySourceError（handler 转 400 invalid_academy_source）
   — 与 hire 入参契约完全一致（同一函数复用）

2. version = academyStore.getVersion(classroomId, versionId)
   sourceWorkspaceDir = version.workspaceDir  // INV-6 不可变真相源

3. 源侧枚举（enumerateVersionSource 内部 helper）：
   agentsMdExists     = existsSync(join(sourceWorkspaceDir, 'AGENTS.md'))
   skillTopNames      = readdir(join(sourceWorkspaceDir, '.rocky', 'skills'))   // 失败→[]
   memoryTopNames     = readdir(join(sourceWorkspaceDir, '.rocky', 'memory'))   // 失败→[]

4. 目标侧 = squadRootDir(dataDir, squadId)（团队盘根）
   for each name in skillTopNames:
     sameNameConflict = existsSync(join(squadRoot, '.rocky', 'skills', name))
   for each name in memoryTopNames:
     sameNameConflict = existsSync(join(squadRoot, '.rocky', 'memory', name))

5. return PreviewResult
```

> AGENTS.md 是个人差异文件（落 `.rocky/agents/{memberName}-{memberId}.md`，文件名带 memberId），天然无同名概念——预览仅返 `agentsMd: { exists: boolean }`，无 sameNameConflict 字段。

### 2.2 PreviewResult schema（与 `11a §2.5` / 前端 client 共享）

```typescript
interface PreviewResult {
  agentsMd: { exists: boolean };  // 学生 AGENTS.md 是否存在（0.0 空版本可能无）
  skills: Array<{ name: string; sameNameConflict: boolean }>;   // 顶层 entry 名（目录或文件）
  memory: Array<{ name: string; sameNameConflict: boolean }>;
}
```

- `name` = 源 `.rocky/skills` 或 `.rocky/memory` 下的**顶层 entry 名**（同级比较，不分文件/目录）。
- `sameNameConflict` = 目标团队盘对应路径已存在同名 entry。
- 源 `.rocky/skills`/`.rocky/memory` 缺失 → 返空数组（不抛错，与 seed 现状口径一致）。
- 预检**纯只读无副作用**（不写任何文件）。

## 3. 裁决语义 + seed conditional copy

### 3.1 裁决 body schema（hire body derive_academy 分支扩字段）

```typescript
type ResolutionItem = { name: string; action: 'skip' | 'overwrite' };
interface DeriveResolution {
  skills?: ResolutionItem[];
  memory?: ResolutionItem[];
}
// hire body derive_academy 分支：resolution?: DeriveResolution（可选）
```

- **per-item 全清单**：前端预览面板同名项 toggle 直接对应 resolution.skills/memory 中的 item。
- **action 闭合枚举 `'skip' | 'overwrite'`**（不引入其他值）。
- **`resolution` undefined = 默认全 skip 同名 + 不同名 merge**（前端可省字段向后兼容；旧 client 不传 → 同名全 skip 安全）。
- **未在 resolution 列出 + 同名 → 默认 skip**；**未在 resolution 列出 + 不同名 → 默认 merge**。
- resolution 列出**不同名项** → 后端宽容处理（按 merge 走，忽略 action）。

### 3.2 默认不覆盖的产品理由（用户决策 D3）

squad 团队盘已有的 skills/memory 是团队现行运作的资产（可能已被其他 mate 使用 / 依赖），静默覆盖会破坏现行行为且用户无感知。默认保留 = 保护存量；用户明确想用学生版本时手动打开覆盖 = 显式意图。

### 3.3 seed conditional copy 算法（`seedMemberWorkspaceFromVersion` 改造）

```
input 加 resolution?: DeriveResolution（可选）

对 .rocky/skills 和 .rocky/memory 各自调 copyDirTrackingConditional：

copyDirTrackingConditional(src, dst, written, items: ResolutionItem[]):
  entries = readdir(src)  // 失败→return（源缺失静默跳过，同现状）
  for entry of entries:
    targetPath = join(dst, entry.name)
    targetExists = existsSync(targetPath)
    item = items.find(i => i.name === entry.name)

    if targetExists and (item === undefined or item.action === 'skip'):
      continue  // 同名 + 默认/显式 skip → 不动 squad 原有，不入 written

    // overwrite（targetExists + action='overwrite'）或 new（!targetExists）：
    try:
      copyDirRecursive(join(src, entry.name), targetPath)  // 覆盖现状语义
      written.push(targetPath)  // 绝对路径，补偿用
    catch:
      // 部分复制失败容忍（同现状）—— 已落盘项仍入 written
      if existsSync(targetPath): written.push(targetPath)

AGENTS.md 复制不变（无同名概念）：源存在 → mkdir .rocky/agents + copyFile 到 {name}-{memberId}.md + written.push（同现状）
```

> `copyDirRecursive` 落点同名覆盖语义不变（ mkdir recursive + 逐项 copyFile 覆盖）；overwrite 分支直接复用。

## 4. 补偿安全不变量（MUST NOT 违反）

`createMemberService` 外层 catch 在 seed 失败时按 `written` 列表 `rmSync(p, { recursive: true, force: true })` 反向清理。加裁决后**安全不变量**（v0.0.232 现状延续 + 本版本明确固化）：

1. **written 只记本次实际写入的顶层目标项**（绝对路径，如 `squads/{sid}/.rocky/skills/foo/`、`squads/{sid}/.rocky/agents/{name}-{memberId}.md`）。
2. **skip 项不入 written** → 补偿不会误删 squad 团队盘原有同名项（核心安全保证）。
3. **written 永不含团队根目录本身**（`.rocky/skills` / `.rocky/memory` / `.rocky/agents` 目录）→ 补偿 `rmSync recursive` 永不删团队根。
4. **AGENTS.md 个人差异文件**同样记入 written（路径 `squads/{sid}/.rocky/agents/{name}-{memberId}.md`），补偿精确删该文件（不删 `.rocky/agents/` 目录）。

> 这套不变量保证：seed 中途失败 → 补偿回滚到「这次 seed 之前」的团队盘状态（squad 原有 skills/memory/agents 一字不动）。

## 5. 边界（不管 → 别处）

| 管 | 不管 |
|---|---|
| 预检算法（读两侧 + 同名检测）+ PreviewResult schema | 本文 ✅ |
| 裁决 body schema + 默认 skip 语义 + conditional copy 算法 | 本文 ✅ |
| 补偿安全不变量（written 只记本次写入） | 本文 ✅ |
| derive_academy 总语义（派生单向 / process 不可派生 / 入参校验） | `[P1]squad_derive.md` |
| AGENTS.md 注入语义（叠加团队 AGENTS.md 之上） | `[P1]prompt_sections.md`（v0.0.232 既定） |
| 预览面板交互形态（清单分组 + toggle + 计数提示） | `specs/ui/components/academy-page/component-derive-academy-picker.md`（coder 编码前置补视觉基线） |
| HTTP 端点契约（路径 / 请求体 / 响应 / 错误码） | `specs/api/overall/11a-squad-endpoints.md §2.1 / §2.5` |
| memory 落点 / 共享语义（团队盘 group scope 全队共享） | `[P0]session_kind_extension.md` + `specs/prd/overall/13-agent-definition.md §13.2.3`（v0.0.232 既定，本版本不改） |

## 6. 不变量（本文件固化）

1. **预检纯只读无副作用** —— `previewDeriveAcademySeed` 不写任何文件；只 `existsSync`/`readdir` 源和目标。
2. **同名默认 skip 是产品语义基线** —— `resolution` undefined / 项未列出 + 同名 → 默认 skip；用户必须显式 action='overwrite' 才覆盖。
3. **AGENTS.md 无同名概念** —— 个人差异文件名带 memberId，预览无 sameNameConflict 字段、seed 无 conditional 分支（直接 copy）。
4. **补偿只删 written，不删团队根** —— 见 §4 四条不变量。

> 与 `[P1]squad_derive.md §5` 关系：`§5.2「派生即独立演化」按资产类型分层成立`（AGENTS.md 个人差异文件成立 / skills-memory 团队盘共享语义下不成立）；本文件不重复该议题，只描预检+裁决机制。
