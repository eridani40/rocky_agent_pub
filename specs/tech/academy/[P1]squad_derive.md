---
type: spec
title: Squad Derive — squad 员工从教室学生版本派生
priority: P1
status: active
updated: 2026-08-04
since: v0.0.210
---

# Squad Derive — 员工从学生版本派生

> 定位：squad hire member 流程扩展第 3 种 mode（fresh / derive / **derive_academy**）。复用现有 hire 事务（`createMemberService`），把学生 formal 版本工作区的关键内容（AGENTS.md / skills / memory）seed 到 squad 团队盘。
> 边界：只管 squad ↔ academy 的桥；squad 核心 schema 不动，academy 数据模型 / 训练引擎不动。
>
> **派生升级（继承预检 + 同名裁决）的机制细节**（预检算法 / 裁决 body schema / seed conditional copy 算法 / 补偿安全不变量）权威见 `[P1]derive_preview_conflict.md`；本文件只描总语义（落点 / 入参 / 不变量）。HTTP 端点契约见 `specs/api/overall/11a-squad-endpoints.md §2.1 / §2.5`。

## 1. 概述

derive_academy = 把 academy 教室学生的一个 **formal + active** 版本工作区内容，seed 到 squad 团队盘，作为新 member 的初始团队资产。落点：

| 源（学生 `version.workspaceDir`） | 目标（`squads/{sid}/` 团队盘） | 共享语义 |
|---|---|---|
| `AGENTS.md` | `.rocky/agents/{memberName}-{memberId}.md` | **个人差异**——member 私有，注入该 member prompt（叠加团队 AGENTS.md 之上） |
| `.rocky/skills/**` | `.rocky/skills/` | **团队盘**——group scope，全队共享读 |
| `.rocky/memory/**` | `.rocky/memory/` | **团队盘**——group scope，全队共享读 |

派生走「继承预检 → 同名裁决 → 执行」三段：

1. **预检**（派生前一步）：独立 endpoint 读两侧，列「将带入」清单 + 标 squad 团队盘已有同名项 → 用户在继承预览面板逐项裁决（同名默认保留 squad 原有，可逐项改覆盖；不同名直接 merge）。
2. **执行**：hire body 携带裁决结果 `resolution?`，seed 按裁决 per-item conditional copy（skip / overwrite / new）。
3. **补偿**：seed 中途失败按 `written`（本次实际写入的顶层目标项）反向 `rmSync`，永不误删 squad 团队盘原有同名项、永不动团队根目录（`[P1]derive_preview_conflict.md §4`）。

> 不复制 `version.json`（mate session 的 model/providerId 走 squad 配置；tools 走 toolBound）。源路径取 `version.workspaceDir` 字段（INV-6 不可变真相源），不重算路径。

## 2. 接口 / 概念模型

### 2.1 入参（`CreateMemberInput` 扩 mode 联合 + academySource）

```typescript
// app/server/src/services/member-service.ts
export interface CreateMemberInput {
  squadId: string;
  mode: 'fresh' | 'derive' | 'derive_academy';
  name?: string;
  intro?: string;
  workStyle?: string;
  tools?: string[];
  skillConfig?: MemberSkillConfig;
  deriveFrom?: string;          // mode='derive' 用
  overrides?: Partial<{...}>;
  academySource?: {             // mode='derive_academy' 用（三字段必填）
    classroomId: string;
    studentId: string;
    versionId: string;          // 必须 formal + active（process 版本 = 训练临时区不可派生）
  };
  resolution?: DeriveResolution; // 仅 mode='derive_academy' 消费（同名裁决结果）
}

// 同名裁决 per-item（闭合枚举 'skip' | 'overwrite'）
type ResolutionItem = { name: string; action: 'skip' | 'overwrite' };
interface DeriveResolution {
  skills?: ResolutionItem[];
  memory?: ResolutionItem[];
}
```

> `resolution` undefined = 默认全 skip 同名 + 不同名 merge（向后兼容）；AGENTS.md 个人差异文件无同名概念，不入 resolution。`fresh` / `derive` 分支带 resolution → accept-and-ignore（不消费、不 warn）。

### 2.2 校验（`resolveAcademyDeriveIdentity`）

`member-academy-bridge.resolveAcademyDeriveIdentity()` 做入参 + 身份字段解析（hire + preview 两入口复用同一函数）：

1. `academySource` 三字段必填；与 `deriveFrom` 互斥（INV-4）→ 普通 Error（handler 转 400）。
2. `name` 必填（squad 内 member 花名册名）。
3. `classroom` 必须存在；`version` 必须 `type='formal'` + `status='active'`（process = 训练临时区不可派生，INV-3）→ 失败 throw `InvalidAcademySourceError`。

handler 层 catch `InvalidAcademySourceError` → 400 `invalid_academy_source`（hire + preview 错误码一致）。预检函数复用同一校验：preview 无 name 概念，传占位 `name='__preview__'` 满足必填，identity 返回值不被消费。

### 2.3 hire 事务扩展（step7 在现有 8 步内）

```typescript
// member-service.ts createMemberService —— workspaceDir = squadRootDir(dataDir, squadId) = 团队盘根
if (input.mode === 'derive_academy' && input.academySource) {
  let written: string[] = [];
  try {
    written = await seedMemberWorkspaceFromVersion({
      academyStore: deps.academyStore,
      classroomId: input.academySource.classroomId,
      sourceVersionId: input.academySource.versionId,
      squadRoot: workspaceDir,
      memberName: eff.name,
      memberId,
      ...(eff.resolution !== undefined ? { resolution: eff.resolution } : {}),
    });
  } catch (seedErr) {
    // 补偿：清 written（MUST NOT rm 团队根），再 rethrow 让外层继续反向补偿 member/session
    for (const p of written) rmSync(p, { recursive: true, force: true });
    throw seedErr;
  }
}
```

> `workspaceDir = squadRootDir(dataDir, squadId)` = squad 团队盘根（非 per-member 子目录），故 seed 直接落团队盘。

### 2.4 预检 + seed 落点

**预检**（`member-academy-bridge.previewDeriveAcademySeed`，纯只读无副作用）：

```typescript
export async function previewDeriveAcademySeed(input: {
  academyStore: AcademyStore;
  classroomId: string;
  studentId: string;
  versionId: string;
  squadRoot: string;
}): Promise<PreviewResult>
```

算法（详 `[P1]derive_preview_conflict.md §2`）：`resolveAcademyDeriveIdentity` 校验 → `version = academyStore.getVersion(classroomId, versionId)` → 内部 helper `enumerateVersionSource(version.workspaceDir)` 枚举 AGENTS.md 是否存在 + `.rocky/skills` / `.rocky/memory` 顶层 entry 名（源缺失返空，不抛错）→ 目标侧对每项 `existsSync(squadRoot/.rocky/{skills,memory}/<name>)` 检测同名 → 返 `PreviewResult`。

```typescript
interface PreviewResult {
  agentsMd: { exists: boolean };  // 个人差异文件无 sameNameConflict（带 memberId 无同名概念）
  skills: Array<{ name: string; sameNameConflict: boolean }>;
  memory: Array<{ name: string; sameNameConflict: boolean }>;
}
```

**seed**（`member-academy-bridge.seedMemberWorkspaceFromVersion`，按裁决 conditional copy）：

```typescript
export async function seedMemberWorkspaceFromVersion(input: {
  academyStore: AcademyStore;
  classroomId: string;
  sourceVersionId: string;
  squadRoot: string;
  memberName: string;
  memberId: string;
  resolution?: DeriveResolution;
}): Promise<string[]>  // written = 本次实际写入的顶层目标项绝对路径列表
```

落点 + 行为：
- **AGENTS.md**（无同名概念，复制不变）：源存在 → `mkdir .rocky/agents + copyFile` 到 `{memberName}-{memberId}.md` + `written.push`；源缺失（0.0 空版本）静默跳过，不留空目录。
- **`.rocky/skills` + `.rocky/memory`**（`copyDirTrackingConditional` 逐顶层项 conditional copy）：同名 + 默认/显式 skip → 不动 squad 原有、不入 written；同名 + `action='overwrite'` 或不同名（new）→ `copyDirRecursive` 复制、入 written；源 `readdir` 失败 → 直接 return（源缺失静默跳过）；单项复制失败 catch 不抛（部分失败容忍，已落盘项仍入 written）。

> `copyDirRecursive` 落点同名覆盖语义不变（`mkdir recursive + copyFile` 覆盖），overwrite 分支直接复用。

## 3. 设计决策

### 3.1 为什么 skills/memory 落团队盘而不是 per-member 盘

squad session 的 `workspaceDir` = `squadRootDir(dataDir, squadId)` = 团队盘根（非 per-member 子目录），member 工作区天然就是 squad 团队盘（共享）。skills/memory 作为 member 可用的团队资产，落团队盘 group scope 全队共享——其他 mate 也能读到这些 memory（group scope），这是用户接受的「继承融合」语义：学生 memory 经派生融入团队共享记忆。

代价：多个 member 各自从不同学生派生、带同名 skill/memory 时，后者会撞前者。用「同名默认不覆盖 + 用户逐项裁决」解决——而不是按 member 名前缀做 namespace 隔离（用户显式拒绝 namespace 方案）。

### 3.2 为什么同名默认 skip 而非 overwrite

squad 团队盘已有的 skills/memory 是团队现行运作的资产（可能已被其他 mate 使用 / 依赖），静默覆盖会破坏现行行为且用户无感知。默认保留 = 保护存量；用户明确想用学生版本时手动打开覆盖 = 显式意图。AGENTS.md 因文件名带 memberId 天然无同名冲突，不走裁决，直接带过去。

### 3.3 为什么预检走独立 endpoint 而非 hire body dryRun

预检 = 纯只读探查（读两侧 + 列清单 + 标同名），与 hire 写事务不同语义层级。dryRun 混进 hire body 会让单 handler 持两套语义（dryRun 跳过事务校验只跑预检），且预检结果回程后裁决结果才生成，dryRun 复用 body 字段逻辑错位。独立 `POST /squad/:id/member/derive-academy/preview` 语义自明；路由天然互斥（4 段 preview path 与 item match `/squad/:id/member/:mid` 3 段的 `:mid`=`[^/]+` 不含 `/` 不冲突）。

### 3.4 为什么 hire + preview 两入口复用同一身份校验

`resolveAcademyDeriveIdentity` 既是 hire 入参契约，也是预检入参契约——同一函数保证两入口对 academySource 三字段必填 / 与 deriveFrom 互斥 / classroom 存在 / version formal+active 的校验完全一致，错误码（400 `invalid_academy_source`）也一致。preview 复用时传占位 `name='__preview__'`（preview 不建 member，name 不被消费），不改 `resolveAcademyDeriveIdentity` 签名。

## 4. UI 形态（design.md §7）

From Classroom 三选项（radio cards）→ 二级 select（classroom → student → version，仅显示 active formal）→ **继承预览面板**（清单分组 AGENTS.md / skills / memory + 同名 amber 标 + 覆盖 toggle + 同名计数提示）→ 现有 member 表单 → POST。

派生按钮在预览加载完成且无 error 前 disabled（避免无裁决提交）。视觉契约见 `specs/ui/components/academy-page/component-derive-academy-picker.md` + `component-derive-academy-preview-panel.md`。

## 5. 不变量

1. **派生单向**：academy 学生 → squad member；反向不可（squad member 不能 import 回 academy）。
2. **「派生即独立演化」按资产类型分层成立**：
   - **AGENTS.md 个人差异文件**（`.rocky/agents/{name}-{memberId}.md`）—— **独立演化成立**：member 私有，文件名带 memberId 隔离，academy 学生版本后续修改不影响该 member；反之亦然。
   - **skills/memory 团队盘**（`.rocky/skills` / `.rocky/memory` group scope）—— **独立演化不成立**：派生后融合进团队盘全队共享，其他 mate 共享读这些 memory；academy 学生版本后续修改不影响团队盘（派生是一次性 copy），但团队盘内容会被后续派生 / 其他 mate 工作触及（受同名默认 skip 保护）。
3. **process 版本不可派生**：只允许 formal + active（保护训练中临时区）。
4. **academySource 与 deriveFrom 互斥**：mode='derive_academy' 用 academySource；mode='derive' 用 deriveFrom；同时传 → 400。
5. **AGENTS.md 无同名概念**：个人差异文件名带 memberId，天然无冲突——预览无 sameNameConflict 字段、seed 无 conditional 分支（直接 copy）。
6. **预检纯只读无副作用**：`previewDeriveAcademySeed` 不写任何文件，只 `existsSync` / `readdir` 源和目标。
7. **补偿只删 written**：skip 项不入 written（补偿永不误删 squad 原有同名项）；written 永不含团队根 `.rocky/skills` / `.rocky/memory` / `.rocky/agents` 目录本身（详 `[P1]derive_preview_conflict.md §4`）。

## 6. 边界

| 管 | 不管（→ 别处） |
|---|---|
| derive_academy mode + academySource 结构 + 入参校验 | 本文 ✅ |
| 预检 + seed 落点（AGENTS.md 个人差异 / skills-memory 团队盘）+ hire 事务 step7 | 本文 ✅ |
| 预检算法 / 裁决 body schema / conditional copy 算法 / 补偿安全不变量（机制细节） | `[P1]derive_preview_conflict.md` |
| HTTP 端点契约（hire body derive_academy 分支 + resolution / 预检 endpoint / 错误码） | `specs/api/overall/11a-squad-endpoints.md §2.1 / §2.5` |
| UI 表单（From Classroom 选项 + 二级 select + 继承预览面板） | `specs/ui/components/academy-page/component-derive-academy-picker.md` + `component-derive-academy-preview-panel.md` |
| squad 核心 schema（member entity / `squadRootDir`） | `../squad/[P1]data_model.md` |
| academy store（`getVersion` / `version.workspaceDir` INV-6） | `[P0]data_model.md` |
| AGENTS.md 注入语义（叠加团队 AGENTS.md 之上） | `[P1]prompt_sections.md` |
| memory 落点 / 共享语义（团队盘 group scope 全队共享） | `[P0]session_kind_extension.md` + `specs/prd/overall/13-agent-definition.md §13.2.3` |
| derive mode（从 mate 派生，配置继承 + 复制父成员个人 AGENTS.md，不拷贝 ws / memory） | 不在本文件（mode='derive' 简述见 §2.1） |
