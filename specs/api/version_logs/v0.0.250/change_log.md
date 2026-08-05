# v0.0.250 — API Change Log（hire derive 删 inheritMemory + 补 step7.5 复制 AGENTS.md）

> 增量变更。全量权威：`specs/api/overall/11a-squad-endpoints.md` + `11-squad.md`。
> 权威输入：`specs/tech/version_logs/v0.0.250/change_plan.md` + `specs/tech/version_logs/v0.0.250/change_log.md`。

## §1 hire derive 端点契约变更（11a §2.1）

### 1.1 HireMemberBody derive 分支删 `inheritMemory`

**契约**（破坏性但 dead）：

```typescript
// v0.0.250 前
| { mode: "derive"; deriveFrom: string; inheritMemory: boolean; overrides?: { ... } }

// v0.0.250 后
| { mode: "derive"; deriveFrom: string; overrides?: { name?; intro?; workStyle?; skillConfig?; model? } }
```

**兼容层**：旧 client body 传 `inheritMemory` → schema 忽略未知字段（CrudStore fs engine 不 reject extra key），不返 400、不落库。无 migration（field 本就 optional + dead——声明「派生复制父记忆」从未落地，memory 已 v0.0.232 团队盘 `.rocky/memory/` 全队共享）。

### 1.2 Member 接口（11a §1.3）删 `inheritMemory`

Member schema 删 `inheritMemory?: boolean` 字段；MemberRecord 派生类型自动收紧。

### 1.3 step 列表加 7.5（derive 复制父成员个人 AGENTS.md）

`createMemberService` 8 步事务扩为 8 步（在 step7 derive_academy seed 之后、step8 补偿回滚之前插 **step7.5**）：

```
7. 建 workspace 目录；derive_academy 在 step7 内 seed（AGENTS.md→个人差异、skills/memory→团队盘）。
7.5. derive（非 academy）：复制父成员个人差异 AGENTS.md
        （.rocky/agents/{父name}-{父id}.md → .rocky/agents/{子name}-{子id}.md，路径字面拼）；
        父成员无个人 AGENTS.md 或复制失败 → 静默 no-op（不触发事务回滚，子继续用团队级 AGENTS.md 兜底）。
8. 任一步失败 → 补偿回滚（反向顺序）。
```

step3 描述「建 member record」（去掉 inheritMemory 提及）；step4 描述「建 member session」（去掉「inheritMemory=true 时复制记忆」虚假行）。

### 1.4 不可改字段收敛

`role / state / squadId / sessionId / deriveFrom / inheritMemory` → `role / state / squadId / sessionId / deriveFrom`（建 member 时一次性定）。

## §2 AT 映射（11 路径 2）

`11-squad.md §7` 路径 2 验证点改述：原「derive 模式 inheritMemory=true 时复制父 member 长期记忆」（虚假）→「derive 模式复制父成员个人 AGENTS.md（非记忆；memory 已团队盘共享）」。

AT 影响：本版本属纯内部清理（dead field 删 + 补 AGENTS.md 复制），用户裁决豁免 AT（无新接口、无对外契约真破坏——旧 client 传 inheritMemory 被 ignore 不 400）。derive 复制 AGENTS.md 由 UT 覆盖（`member-academy-bridge.test.ts` 3 tests + step7.5 integration 2 tests，全绿 9262 passed | 4 skipped）。

## §3 错误码

无新增、无移除错误码。`409 member_name_conflict`（name 重复）+ `400 intro required`（fresh 缺 intro）等保持不变。
