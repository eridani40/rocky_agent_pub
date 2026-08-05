# v0.0.51-long_term_memory API 变更日志 — self-evolution 引入（memory_manage + skill_manage agent 工具 + UI governance HTTP 端点）

> version: 1.0 · 2026-07-03
> 一句话定位：本版本引入 self evolution 的对外接口——
>   ① **2 个新 agent tool**（`memory_manage` + `skill_manage`），非 HTTP（LLM tool_use 调），AT 通过真 LLM session 验落盘；
>   ② **1 个新 HTTP 端点** `PATCH /skill/:name/governance`（UI 改 `mutable` 字段，受 `mutableLocked` 强制约束）；
>   ③ **SkillEntry schema 扩展**：加 `mutableLocked` 字段（lazy 默认 false，向后兼容）+ `source` 加 `system` 值 + `productionMethod` 加 `builtin` 值。
> 权威：契约权威源在 tech spec；`specs/api/overall/` 做 HTTP 端点契约（`06a-skill-governance.md`）+ agent tool 索引（`14-self-evolution-tool-ref.md`）。
> 关联：tech `specs/tech/agent/memory/[P0]memory_manage_tool.md` + `specs/tech/agent/skills/[P0]skill_manage_tool.md` + `specs/tech/agent/skills/[P0]skill_definition.md §6/§8`；prd `specs/prd/version_logs/v0.0.51-long_term_memory/change_log.md`。

---

## 1. 新增 HTTP 端点

### 1.1 `PATCH /skill/:name/governance`（UI 改 mutable 字段）

- 详见 `specs/api/overall/06a-skill-governance.md`（完整契约 + service 层强制逻辑）。
- **请求**：body `{ scope: 'app'|'workspace', mutable: boolean, workspace?: string }`
- **响应**：`200 { skill: SkillEntry }`（含已更新的 mutable）
- **错误**：
  - `400` body 格式错 / workspace 缺失
  - `403` **`mutableLocked === true`**（skill 已锁定，需手编辑 frontmatter）
  - `404` name 不存在
  - `409` scope 未显式指定且同名跨层冲突
- **关键设计**：独立 HTTP 端点，**不经过 skill_manage agent 工具**（agent 永远不能改 mutable，无论 mutableLocked 真假）。强制点在 service 层（SkillsService 或等价 handler）。

## 2. 既有端点 schema 扩展（向后兼容）

### 2.1 SkillEntry 加 `mutableLocked` 字段

`06-skill.md §8` SkillEntry interface 新增字段：

```typescript
interface SkillEntry {
  // ...既有字段（name/description/scope/skillDir/enabled）...
  source?: 'user' | 'agent' | 'system';        // [v0.0.51] 加 system 值
  productionMethod?: 'handwritten' | 'consolidation' | 'download' | 'builtin';  // [v0.0.51] 加 builtin 值
  mutable?: boolean;                            // 既有（v0.0.21）
  mutableLocked?: boolean;                      // [v0.0.51 新增]，lazy 默认 false
}
```

**影响端点**（所有返回 SkillEntry 的响应）：
- `GET /skill`（list，`06-skill.md §3`）
- `POST /skill/install` 响应（`06-skill.md §2`）
- `PATCH /skill/:name` toggle enabled 响应（`06-skill.md §4`）
- `PATCH /skill/:name/governance` 响应（`06a-skill-governance.md §2.2`）

**lazy 默认 false 兼容存量**：现存 skill（v0.0.51 之前 install）的 frontmatter 无 `mutableLocked` 字段 → resolver 规范化 → 缺省 false（用户对自己资产默认有 UI 控制权）。**无需 migration**。

### 2.2 source / productionMethod 枚举扩展

为支持「系统内置 / 敏感固化」场景（`source=system, method=builtin, mutable=false, mutableLocked=true`，见 `skill_definition.md §6.3` 默认值表）：
- `source` 加 `'system'` 值
- `productionMethod` 加 `'builtin'` 值

向后兼容（新增枚举值不影响旧解析）。

## 3. 新增 agent tool 索引（非 HTTP）

### 3.1 `memory_manage` 工具

- **契约权威**：`specs/tech/agent/memory/[P0]memory_manage_tool.md` §2（接口）+ §3（action 语义）
- **API 索引**：`specs/api/overall/14-self-evolution-tool-ref.md §2`
- **action**：`write`（upsert）/ `archive`（不删，可恢复）/ `list`（metadata）/ `read`（全文）
- **scope**：`user`（跨 session/agent 全局）/ `session`（当前 session 专属）
- **不审批契约**：agent 自主落盘，无人工 gate

### 3.2 `skill_manage` 工具

- **契约权威**：`specs/tech/agent/skills/[P0]skill_manage_tool.md` §2（接口）+ §3（action）+ §4（mutable 强制）
- **API 索引**：`specs/api/overall/14-self-evolution-tool-ref.md §3`
- **action**：`create` / `patch` / `disable` / `enable` / `list`（含 disabled）/ `read`（含 disabled）
- **mutable 强制（agent 路径）**：`patch/disable/enable` on `mutable=false` → REJECT；agent 工具完全无视 `mutableLocked`；payload 永远不含 mutable 字段
- **不可 delete**：用 `disable` 替代（设 enabled=false，可恢复）

## 4. AT 覆盖（real LLM ark glm-5.2 + real HTTP curl）

| 模块 | 验证方式 | 关键 case 类型 |
|------|---------|---------------|
| `memory_manage` | 真 LLM session prompt → tool_use → 查真落盘 `<dataDir>/memory/*.md` | write 新建 / upsert / archive / list metadata / read 全文 |
| `skill_manage` | 真 LLM session prompt → tool_use → 查真落盘 `<scope>/skills/<name>/SKILL.md` + app_config | create / patch（mutable=true 允许）/ **patch REJECT（mutable=false）** / disable / enable / list 含 disabled / read 含 disabled |
| governance HTTP | real curl PATCH → 200 / 403 / 查 frontmatter 同步 | UI 切 mutable 双向 / **mutableLocked=true 403 拒绝** / scope 缺省 409 |

**共同约定**（见 `14-self-evolution-tool-ref.md §7`）：
- real LLM（不 mock），通过 user 自然语言 prompt 触发 tool_use
- 真落盘验证（每个 case 查磁盘真实文件最终态）
- AT designer 不扒代码，契约从 tech spec + 索引文件拿

## 5. 复用端点（既有，shape 扩展）

- `GET /skill` / `POST /skill/install` / `PATCH /skill/:name`（toggle enabled）/ `DELETE /skill/:name` / `GET /skill/:name/tree` / `GET /skill/:name/file` —— 全部既有，响应 SkillEntry 加 `mutableLocked` 字段（向后兼容）
- `GET /session/:id/debug/system-prompt`（test only）—— 既有，不变

## 6. 不在本版本 API 范围

- 矛盾检测 / content_type 衰减 / 批量整理接口（memory P1）
- skill patch 的 diff 策略（全文替换 vs section 级）/ allowedTools 默认值 / skill 依赖关系（skill P1）
- UI HTTP 路径改 mutableLocked 字段（本期只能手编辑 frontmatter）
- 并发写 per-file lock 序列化的 AT 覆盖（UT 覆盖即可，AT 用单 session 验落盘语义）

## 7. 版本

v0.0.51-long_term_memory（self evolution 引入——2 个 agent tool `memory_manage` + `skill_manage`（不审批 / mutable 强制 / 不可 delete）+ UI governance HTTP 端点 `PATCH /skill/:name/governance`（受 mutableLocked 强制）+ SkillEntry schema 扩展（加 mutableLocked 字段 + source/productionMethod 枚举扩展））。
