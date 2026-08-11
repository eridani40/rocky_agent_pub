# leader.md 命名 Bug 调研报告

日期：2026-08-10 · 调研人：researcher · 分支：v0.0.319-team-sync worktree

## 一、问题现象

用团队模板创建 squad 后，`.rocky/agents/` 下产生 `leader.md`（保留模板原名），而正确命名应为 `leader-{leaderMemberId}.md`（对齐其他 mate 的 `{name}-{memberId}.md`）。

**实际验证**（当前 prod squad 01KZA61YTQBB05NBSWEWWCFWMV）：
- `squad_template/.rocky/agents/leader.md` — 存在，未改名（模板残留）✅ 问题复现
- `.rocky/agents/Darvin-01KZA61YTQBB05NBSWEWWCFWMW.md` — 正确命名存在（leader name=Darvin, memberId=01KZA61YTQBB05NBSWEWWCFWMW）✅ 说明 leader 的正确文件其实也存在（另一来源）

即：模板复制产生了 `leader.md`（无效文件），同时 squad 里已有 `Darvin-{id}.md`（有效文件）。`leader.md` 因命名不符合 `{name}-{memberId}.md` 约定，**永远无法被注入逻辑命中**（见 §三 影响面）。

## 二、根因链路

### 2.1 manifest 结构：leader 是独立字段，不在 members 里

`webapp-dev-team/manifest.json`（app/plugins/builtins/squad-templates/webapp-dev-team/manifest.json）：
```json
{
  "leaderName": "Darvin",
  "leaderIntro": "团队 leader，...",
  "members": [ { "name": "prd", ... }, { "name": "coder", ... } ]
}
```
- `leaderName` / `leaderIntro`：顶层独立字段
- `members`：**只含 mate**，不含 leader

确认：`leader in members? False`（脚本验证）

### 2.2 nameToId 只从 members 构建 → leader 永不进映射

`squad-template-service.ts` `applyTemplate()`（L151-170）：
```ts
const nameToId = new Map<string, string>();
for (const spec of manifest.members) {        // ← 只遍历 members（mate）
  const result = await createMemberService(...);
  nameToId.set(spec.name, result.member.id);  // ← 只有 mate 进映射
}
copyTemplateFiles(srcDir, destDir, nameToId);
```

`copyTemplateFiles()`（L208-223）：
```ts
for (const file of readdirSync(srcAgentsDir)) {
  if (!file.endsWith('.md')) continue;
  const role = file.replace(/\.md$/, '');     // leader.md → role='leader'
  const memberId = nameToId.get(role);        // 'leader' 不在映射 → undefined
  const destName = memberId ? `${role}-${memberId}.md` : file;  // ← 未命中保留原名 leader.md
  copyIfExists(srcAgentsDir/file, destAgentsDir/destName, false);
}
```

**根因**：`leader.md` 的 role='leader' 在 `nameToId` 里查不到（leader 由 `createSquadService` 在 applyTemplate 之前创建，其 memberId 从未被写入 nameToId）→ 保留原名 `leader.md`。

### 2.3 leader 的 memberId 从哪来（createSquadService）

`squad-service.ts` `createSquadService()`（L180-230）：
- `leaderMemberId` = 独立生成的 member id（`memberStore.putMember({ id: leaderMemberId, name: input.leader.name, role: 'leader', ... })`）
- leader 是 squad 创建流程（step 4）的一部分，**先于** applyTemplate 执行
- `applyTemplate` 返回值（created/failed）**不含 leaderMemberId**——applyTemplate 完全不知道 leader 的 id

### 2.4 v0.0.319 团队同步导入同样受影响

`team-sync-import-service.ts` `importSquadFromTempDir()`（L120-175）：
- 同样 `createSquadService({ leader: { name: manifest.leaderName } })` 先建 leader
- 同样只遍历 `manifest.members` 构建 nameToId（L147-159）
- 同样复用 `copyTemplateFiles(srcDir, destDir, nameToId)`（L168）
- **结论：两条路径（模板创建 + 团队同步导入）都受影响**，因为共用同一个 copyTemplateFiles

## 三、影响面

### 3.1 注入逻辑按 `*-{memberId}.md` 后缀扫描 → leader.md 永不命中

`context_files.ts`（app/plugins/builtins/rocky_context/prompt/context_files.ts）`findPersonalAgentsFile()`：
```ts
const suffix = `-${memberId}.md`;
const hit = fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).sort()[0];
```

- 注入只认 `{name}-{memberId}.md` 后缀（memberId ULID 26 字符）
- `leader.md` 无后缀 → **永远扫不到 → leader 个人 AGENTS 注入失效**
- 但注意：当前 squad 有 `Darvin-{id}.md`（正确命名），所以 leader 注入实际走的是这个文件——`leader.md` 是**冗余死文件**（不会被读，但占空间、误导）

### 3.2 当前 squad 的 Darvin-{id}.md 从哪来

对比内容：模板 `leader.md` 与当前 `Darvin-{id}.md` **内容不同**（模板是新版「项目初始化 MANDATORY」风格，Darvin.md 是旧版「Multi-Agent Orchestrator」风格）→ 当前 squad 的 leader 文件**不是**模板复制产生的，而是历史上其他途径（手动放置/早期版本逻辑）生成。

但 `squad_template/.rocky/agents/leader.md` 的存在证明：**模板复制确实把 leader.md 原样拷进了 squad 目录**（这个 squad_template 目录是某次模板应用留下的）。

### 3.3 具体影响

| 影响 | 严重度 | 说明 |
|------|--------|------|
| leader 个人 AGENTS 注入失效 | 高（若只有 leader.md 时） | 新 squad 从模板创建后，若用户没手动放 `{leaderName}-{leaderId}.md`，leader 的个人差异文件完全不注入 |
| `{name}-{memberId}.md` 命名约定破坏 | 中 | leader.md 不符合约定，导出的 stripMemberIdSuffix 无法处理（正则 `-[ULID26].md$` 不匹配） |
| 团队同步导出/导入循环 | 中 | 导出时 leader.md → stripMemberIdSuffix 不匹配 → 原样导出 leader.md → 再导入又原样复制 → 死文件累积 |
| 冗余文件 | 低 | leader.md 占空间、与正确文件并存易混淆 |

### 3.4 存量验证

- 当前 prod squad：`squad_template/.rocky/agents/leader.md` 存在（残留）+ `.rocky/agents/Darwin-{id}.md` 存在（正确）
- 其他 squad 无 `.rocky/agents/leader.md` 残留（find 未命中其他 squad）——因为其他 squad 可能没用模板创建，或模板应用在更新版本后
- **存量影响有限但真实存在**：凡是走模板创建/同步导入的 squad，都可能残留 leader.md

## 四、正确行为与修复建议

### 4.1 leader 的 agent md 应叫什么

`leader-{leaderMemberId}.md`（如 leader-01KZA61YTQBB05NBSWEWWCFWMW.md）——对齐 mate 的 `{name}-{memberId}.md` 约定，使注入扫描 `*-{memberId}.md` 能命中。

注意：注入扫描只认 memberId 后缀，**前缀可以是任意名字**（name 可改，memberId 是 ULID 不变量）。所以即使 leader 名字叫 Darvin，文件也可以叫 `leader-{id}.md` 或 `Darvin-{id}.md`，只要后缀是 memberId 就能命中。

### 4.2 copyTemplateFiles 应如何纳入 leader

方案 A（推荐，改动最小）：applyTemplate / importSquadFromTempDir 在调用 copyTemplateFiles 前，把 leader 也 set 进 nameToId：
```ts
// applyTemplate 里，createSquadService 之后：
nameToId.set(manifest.leaderName, created.leaderMember.id);  // 需要 createSquadService 返回 leaderMemberId
```
但 applyTemplate 当前签名不接收 leader memberId——需要 handler 层把 `created.leaderMember.id` 传进来，或在 applyTemplate 内部重新查 leader。

方案 B（更通用）：copyTemplateFiles 增加对 `leader.md` 的特殊处理——若 srcAgentsDir 有 leader.md，用 squad 的 leaderId 改名：
```ts
if (role === 'leader') {
  const leaderId = /* 从 squad store 读 leaderId */;
  destName = `leader-${leaderId}.md`;
}
```
但 copyTemplateFiles 当前签名只有 (srcDir, destDir, nameToId)，没有 squad 上下文——需要加参。

方案 C（对齐导出逻辑）：导出（team-sync-export）时 leader.md → 去 memberId 已是 `leader.md`（stripMemberIdSuffix 对 `leader-{id}.md` 会正确 strip 成 leader.md）；导入时若 manifest.leaderName 在 nameToId 里（补 leaderName→leaderId），copyTemplateFiles 的 `role=leader` 命中改名 `leader-{leaderId}.md`。**与方案 A 本质相同，只是强调导出/导入对称**。

**推荐方案 A/C 组合**：
1. applyTemplate 与 importSquadFromTempDir 都补充 `nameToId.set(manifest.leaderName, leaderMemberId)`（leaderMemberId 从 createSquadService 返回或 squadStore 读）
2. copyTemplateFiles 无需改动（role='leader' 在映射里 → 自然改名）
3. 同步补测试：assert `leader-{id}.md` 存在

### 4.3 存量清理

已残留 leader.md 的 squad：手动删除或加一次性迁移（可选，低优先——死文件不影响功能，只是冗余）。

## 五、版本溯源

- `applyTemplate` + `copyTemplateFiles` 引入于 **v0.0.298 T1**（2583228db "Squad Templates backend - template read + builtin sync + create from template"）——bug 从 v0.0.298 起存在
- v0.0.319（0a97ba612 "团队同步（导入导出团队配置 zip）"）复用 copyTemplateFiles → 同步导入路径同样受影响
- 注：leader.md 命名问题与 v0.0.317 无关（leader 字段独立于 members 的结构自 v0.0.298 模板功能引入时即如此）

## 六、证据清单

| 证据 | 位置 |
|------|------|
| manifest leaderName 独立字段 + members 只含 mate | app/plugins/builtins/squad-templates/webapp-dev-team/manifest.json |
| nameToId 只遍历 members | squad-template-service.ts L151-170 |
| copyTemplateFiles 未命中保留原名 | squad-template-service.ts L208-223 |
| leader 由 createSquadService 创建（先于 applyTemplate） | squad-service.ts L180-230 |
| 同步导入复用 copyTemplateFiles + 同样只遍历 members | team-sync-import-service.ts L120-175 |
| 注入只认 `*-{memberId}.md` 后缀 | context_files.ts findPersonalAgentsFile |
| 导出 stripMemberIdSuffix 正则（ULID 26 字符） | team-sync-export-service.ts L24-41 |
| 存量残留 leader.md | squads/01KZA61YTQBB05NBSWEWWCFWMV/squad_template/.rocky/agents/leader.md |
| spec 约定（{role}.md → {name}-{memberId}.md） | specs/tech/squad/[P1]squad_templates.md §② L73-77 |
