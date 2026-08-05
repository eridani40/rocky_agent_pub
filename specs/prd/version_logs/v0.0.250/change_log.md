# v0.0.250 — PRD Change Log（hire derive 删 inheritMemory + 补复制 AGENTS.md）

> 增量变更。全量权威：`specs/prd/overall/08-squad-studio.md`。
> 权威输入：`specs/tech/version_logs/v0.0.250/change_plan.md` + `states/v0.0.250/context.md`。

## §1 用户可感知变化

### 1.1 Derive 区 inheritMemory toggle 删除（dead UI）

**位置**：成员创建页 Derive 模式（`section-member-create.tsx`）。

**原 UI**：Derive = 父成员选择卡 + **inheritMemory toggle**（label「继承父角色长期记忆」）+ 可选覆盖 name/intro/workStyle。

**新 UI**：Derive = 父成员选择卡 + 可选覆盖 name/intro/workStyle（去掉 toggle）。

**理由**：toggle 是**虚假承诺**——hint 文案「继承父角色长期记忆」对应的复制功能从未实现（server 端 `inheritMemory` 字段落盘但全 server grep 无消费）。memory 已 v0.0.232 转团队盘 `.rocky/memory/` 全队共享，无「派生复制父记忆」语义。server 删字段后 toggle 成 dead UI（提交一个 server 不再消费的字段），用户裁决纳入清理（architect 推荐「不遗留死代码」）。

**用户影响**：可见 UI 变化（少一个 toggle）但**无功能退化**（toggle 本就不工作）。

### 1.2 derive 补齐复制父成员个人 AGENTS.md（无 UI 变化，后台行为补齐）

v0.0.232 引入 AGENTS.md 两级读取（团队 `squads/{sid}/AGENTS.md` + 个人差异 `.rocky/agents/{name}-{memberId}.md`）后，**derive 模式只继承 record 字段、不复制父成员个人 AGENTS.md**——本版本在 hire 事务 step7.5 补齐：派生时复制父成员的个人差异 AGENTS.md 到子成员名下。父成员无个人 AGENTS.md → 子继续用团队级 AGENTS.md 兜底（静默 no-op）。

**用户感知**：派生出来的成员继承父成员的个性化指令（个人差异 AGENTS.md），不再只用团队级 AGENTS.md。

## §2 §8.7 v0.0.169 承接行 follow-up

v0.0.169 「squad 成员页优化」交付的主区创建页含 inheritMemory toggle，本版本（v0.0.250）作为 follow-up 清理该 dead UI（`[v0.0.250 follow-up]`）。原 v0.0.169 承接行末追加 follow-up 标注。

## §3 关键用户路径（§8.3 路径 2）

路径 2「hire member（fresh + derive）」更新：

- 旧：`Derive 选父 + inheritMemory + 可选覆盖`
- 新：`Derive 选父 + 可选覆盖 name/intro/workStyle` + 注明「Derive 区原 inheritMemory toggle 已删（dead UI）」

无新路径、无路径删除。

## §4 测试范围

本版本属**纯内部清理**（dead field 删 + 补 AGENTS.md 复制 + dead UI 拆除），用户裁决豁免 AT/ET（无新接口契约、UI 变化是减法）。覆盖由 UT 兜底（全绿 9262 passed | 4 skipped，含新 bridge helper 3 tests + step7.5 integration 2 tests）。
