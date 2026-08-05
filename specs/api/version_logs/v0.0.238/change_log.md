# v0.0.238 API Change Log — prompt 注入质量 / 整理机制健康化

## 14-self-evolution-tool-ref.md

- **scope 必填无默认 + 按 biz 校验**（memory_manage write/archive + skill_manage create/patch/disable/enable）：不传 scope → `[invalid_input]` + biz 可用层引导；传本 biz 不可用层 → 同样拒绝。可用层按 biz：playground→session/global、studio→group/global、academy→三层（来自 `biz-scope-rules.ts`）。read 保留缺省 global（读侧宽容）。
- **skill_manage scope 对外加 `group`**（暴露 squad 团队层，与 memory 同词表 `global|session|group`）。
- **长度口径**：memory 300 词 → **intro ≤50 字符 / body ≤500 字符**（trim 后 str.length）；skill description 1024 → **≤50 字符**（agent 写侧 executeCreate/executePatch 硬检查；UI 市场安装路径不受影响）。
- AT 可测点更新：路径 E（300 词 → 500 字符 body 硬限）；路径 G（默认 global → scope 必填拒绝）。

## 15-memory-ui.md

- 长度硬限：300 词 → **intro ≤50 字符 / body ≤500 字符**（`MemoryCharLimitError` 携 field/current/limit → HTTP 400 `charLimitTo400`）；落 dir store `writeLocked` 服务层单点（覆盖 UI + agent 两路径）。
- 与 `memory_manage` 工具边界表：scope 列从「默认 global」改为「必填无默认 + 按 biz 校验」；长度从「300 词」改为「intro ≤50 / body ≤500 字符」。
