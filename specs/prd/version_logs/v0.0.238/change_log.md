# v0.0.238 — prompt 注入质量治理（自律段 + T1 整理者化 + 分层配额 + 硬长度检查）

> 类型：prompt 组装层 + 整理机制 + 写入校验功能新增（用户可感知：prompt 内容、T1 行为、写入拒绝、注入配额）
> 权威 req：`reqs/[working] v0.0.238/req.md`（用户 2026-08-02 拍板 4 点决策）+ 2026-08-02 scope 终裁（协调者传达：按 biz 可用表 + 写侧必填/按 biz 校验，覆盖 req.md §3 的「优先更 private + 默认」表述）
> 调研底稿：`reqs/[working] v0.0.238/analysis.md`（机制病灶 + 成因链 + 代码钉死项，已核实）
> 全量定义：`specs/prd/overall/14-prompt-quality-governance.md`（本版本新增 overall 文件）

## 0. 决策基线（用户已拍板，本 PRD 不推翻）

| # | 决策 | 出处 |
|---|------|------|
| D1 | 「定义你的 agent」板块加自律治理段：AGENTS.md/memory/skill 质量标准（分层归位、个人只写差异、描述即路由、会删比会写重要） | req.md §1 |
| D2 | T1 consolidate 打开文件读写工具权限（read/write/edit/glob/grep 全给） | req.md §2 |
| D3 | 放权 T1 改 AGENTS.md，标准说清楚；红线：禁删用户钦定铁律/角色定位 | req.md §2 + context findings |
| D4 | T1 指令指明 AGENTS.md 位置：团队 `squads/{sid}/AGENTS.md` + 个人 `.rocky/agents/{name}-{memberId}.md` | req.md §2 |
| D5 | T1 整理标准 5 条：AGENTS.md 只留角色+规则、skill description 是路由语言、memory 是长期事实非流水、团队/个人不重复、控制总体量 | req.md §2 |
| D6 | scope 分层配额：session ≤20 / group ≤30 / global ≤50（覆盖统一 50） | req.md §3 |
| D7 | 写侧 scope 必填（去默认 global）+ 按 biz 校验可用 scope；可用表：playground=session/global、studio=group/global（无 session）、academy=session/group/global（三层）——2026-08-02 二次拍板 | 协调者终裁 |
| D8 | 硬长度检查：skill description / memory intro ≤50 字、memory 全文 ≤500 字，超限拒绝 | req.md §3 |
| D9 | 非目标：不清理存量、不改 resolver 4 层优先级、L2 衰减排序后续 | req.md「非目标」 |
| D10 | skill 侧 studio 需能用 group（现状对外仅 global/session，squad workspace↔group 同址）——暴露 group 或工具层映射，方案待架构定 | 协调者终裁 |

## 1. 背景

实测 squad leader system prompt ~62KB / ~20.7k tok，agent 自定义内容（AGENTS.md + skills L0 + memory L0）占 ~75%，且机制只设「量」护栏（虚设字符上限、统一 50 条配额、时间倒序）不设「质」护栏；T1 是唯一定期整理机制但只会加不会清（toolBound 碰不到 AGENTS.md、指令无整理职责）。详 `analysis.md`。

## 2. 产品解法（对应 overall §14.2）

1. **agent_profile d) 自律治理段**（P0）：4 条质量标准 + scope 语义 + 路由方向；同一 mapper 渲染（§13.2.1 铁律），全 kind 注入，stable/480 不变。
2. **T1 整理者化**（P0）：allowed tools 扩 `[skill_manage, memory_manage, read, write, edit, glob, grep]`；指令按 kind 渲染 AGENTS.md 路径（团队+个人）；5 条整理标准；红线（禁删铁律/角色定位、不删文件、memory 只 archive、skill 只 disable、evolvable=false 不动）；触发机制（sibling 双发/锁/fire-and-forget）不变。
3. **scope 分层配额 + 写侧必填/校验**（P0）：注入侧 session ≤20 / group ≤30 / global ≤50 分层独立截断（memory/skill 同构，按 biz 对齐可用层）；写侧两道新机制——scope 必填（去默认 global）+ 按 biz 校验可用 scope（可用表见 D7），不传/传错层报错并按 biz 引导；T1 继承主 session biz 的 scope 规则。
4. **写入硬长度检查**（P0）：skill description 必填 ≤50 字；memory intro ≤50 字、body ≤500 字；超限拒绝不落盘；覆盖旧口径（description 1024→50、body 300 词→500 字符）；存量不追溯。

## 3. 关键用户路径（= 测试最低覆盖）

见 overall `14-prompt-quality-governance.md` §14.3（6 条：自律段注入 / 超限拒绝 / 分层截断 / 路由落 session / T1 整理全链路 / 存量不回归）。

## 4. 与既有决策的关系

- **v0.0.232**（agent_profile 统一 mapper 铁律）：延续——d) 段不拆 mapper/模板。
- **v0.0.205**（T1 默认翻 session、工具/UI 默认 global 不变）：**被 scope 必填整体取代**——不再有任何默认值；T1 按主 session biz 渲染可用表；UI 手动新建路径的必填/按 biz 过滤形态待架构/UI 落 spec。
- **v0.0.149 / v0.0.112**（注入配额 + L0 翻转）：迭代——统一 50 总量配额升级为分层 20/30/50；层内排序规则（updatedAt 倒序 + tiebreak）不变。

## 5. 范围边界（IN / OUT）

见 overall §14.4。核心 OUT：不清理存量实例数据、不改 resolver 优先级与 memory scope 语义、L2 衰减排序后续、AGENTS.md frontmatter 治理不做（红线为指令层）、budget_truncate 接线不属本版。
