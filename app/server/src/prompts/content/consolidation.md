[整理任务前缀]
You are now performing a memory + skill + AGENTS.md consolidation pass on the conversation above (the full pre-compaction dialogue is already in your context).
Your job: extract reusable long-term memory entries and skills worth persisting, optionally tidy the AGENTS.md files listed below, then **directly call the tools** (`memory_manage` / `skill_manage` / `read` / `edit`) to write changes to disk.

[先判断是否有整理工作 — 不强制产出]
Step 1 — Decide if there is anything worth consolidating:
- User corrections / preferences revealed (e.g. "always do X", "never do Y", stylistic feedback)
- Decisions / commitments / conventions that future sessions should remember
- Reusable workflows that would benefit from being captured as a named skill
- Facts about the user / project / environment that will likely be referenced again
- AGENTS.md drift: role/definition text that has clearly gone stale relative to how the agent now behaves

If **nothing** in the conversation is worth consolidating → stop, output a one-line acknowledgement, and **call no tools**. Do not invent low-value entries just to produce output.

Step 2 — If there is work to do, for each item decide what to write and where:

{{routing_rules}}

{{scope_table}}

Then call the matching tool: `memory_manage.write` (new / updated memory) · `memory_manage.archive` (obsolete memory) · `skill_manage.create` (new skill, frontmatter auto-set: source=agent, method=consolidation, evolvable=true) · `skill_manage.patch` (revise an existing skill). scope is REQUIRED on every write/archive call — omitting it or passing a scope not available for your biz is rejected with the available list.

[整理对象 — AGENTS.md]
{{agents_paths}}

Only tidy AGENTS.md files listed above (or, if the line says this scenario does not tidy AGENTS.md, skip this part and only consolidate memory/skill). Use `read` to inspect, then `edit` to revise — never `write` to overwrite the whole file (loses user-curated structure).

[整理标准 — 5 条]
1. **分层归位**：session/group/global 各放其位；同一事实只保留一层（不要 session + global 各写一份）。AGENTS.md 团队层与个人层不重复（团队有的规则不再抄进个人）。
2. **个人只写差异**：个人 AGENTS.md / session memory 只放「与默认/团队不同的差异点」；团队或全局已有的不重复写。
3. **描述即路由，≤50 字符**：skill description 是注入清单的「路由语言」，必须 ≤50 字符（超限被工具硬拒）；memory intro 同理（≤50 字符），memory body ≤500 字符。写的是结论不是流水。
4. **会删比会写重要**：发现已过时 / 与现状矛盾 / 与新事实重复的旧条目，优先 archive（memory）/ disable（skill）/ 在 AGENTS.md 中删段，而不是再写一条新的。各 scope 配额：session 20 / group 30 / global 50；接近上限时主动 archive 最旧的 evolvable=true 条目。
5. **质量优先于数量**：宁可只写 1 条真正长期有用的事实，也不要写 5 条「这次对话里提过但下次用不上」的流水。

[约束与红线]
- Each entry must be specific and actionable — no vague platitudes ("be helpful").
- Skill bodies should reference concrete steps / triggers / examples, not generic advice.
- Do NOT duplicate items already present in this conversation's earlier tool calls (the conversation above includes any in-session `memory_manage` / `skill_manage` invocations — check before writing).
- Respect `evolvable=false` governance: `skill_manage.patch` / `disable` / `enable` will be REJECTED by the tool itself for non-evolvable skills — do not retry, just skip.
- Keep each memory body concise: intro >50 chars or body >500 chars is hard-rejected by `memory_manage.write` — write the conclusion, not a transcript.
- **红线（绝对禁止）**：
  - 禁止删除用户在 AGENTS.md 中钦定的角色定位 / 铁律 / 偏好（即使你判断「过时」）；只能改冗余、矛盾、明显事实错误的部分。拿不准的段保留原样。
  - 禁止用 `write` 覆盖整份 AGENTS.md（必须用 `edit` 外科式修改单段）；禁止删除 AGENTS.md 文件。
  - memory 只能 archive（不可 delete）；skill 只能 disable（不可 delete）；archive/disable 都是可逆的，物理删除不存在。
  - `evolvable=false` 的条目一律不动（read-only，整理者也无权改）；只能在总结里标注 concerns，不能 archive/disable/patch 它们。
