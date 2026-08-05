/**
 * biz-scope-rules —— 写侧 scope 可用表的单点共享模块（功能3：scope 必填 + 按 biz 校验）。
 * 参考: specs/tech/version_logs/v0.0.238/change_plan.md 模块 A（6 符号）+ 架构决策 O4/O5
 *       specs/prd/overall/14-prompt-quality-governance.md §14.2.3（可用表 + 必填）
 *
 * 设计意图（change_plan O4/O5）：
 *   - scope 写侧必填（去旧默认 global）+ 按 biz 校验可用层，需要一个**数据与文案分离**的单源。
 *   - 本模块承载 biz 解析 + 可用表常量 + 三个文案/渲染函数，被 4 个消费方自动同源引用：
 *     ① memory-manage / skill-manage run()（写侧校验 + 错误文案）
 *     ② agent_profile d) 段（renderScopeTableForPrompt 按 biz 渲染）
 *     ③ consolidation-handler {{scope_table}} 占位符（同上）
 *   - routing_decision.md Step 2 是模块级静态文案（无法按 session 渲染），放全 biz 静态表；
 *     动态按 biz 渲染走本模块的 renderScopeTableForPrompt（仅 d) 段 + scope_table + 运行期错误消息三处）。
 *   - biz 解析容错（resolveBizScopeKind 不抛错）：tier2 三 run 无 kind → 兜底 playground（与 agent-side-run.ts L95 兜底一致）。
 */

/** 业务场景三值（闭合 union，对齐 @app/shared BizType） */
export type BizScopeKind = 'playground' | 'studio' | 'academy';

/** 三层 scope 语义常量（统一文案，避免各处措辞漂移） */
const SCOPE_SEMANTICS: Readonly<Record<string, string>> = {
  session: '仅本会话（会话结束/压缩后不可见，适合临时上下文）',
  group: '本团队共享（同 squad 成员可见，适合团队级约定）',
  global: '跨项目全局（所有会话可见，适合长期通用事实）',
};

/** scope 分层配额（注入侧 + 写侧引导统一口径：20/30/50） */
const SCOPE_QUOTAS: Readonly<Record<string, number>> = {
  session: 20,
  group: 30,
  global: 50,
};

/**
 * 各 biz 可用的 scope 层表（PRD §14.2.3 / D7 终裁）。
 * memory/skill 同词表（studio 无 session 层、academy 三层全开）。
 * 数据与文案分离：本表是纯数据，渲染由 renderScopeTableForPrompt 消费。
 */
export const AVAILABLE_SCOPES_BY_BIZ: Readonly<Record<BizScopeKind, readonly string[]>> = {
  playground: ['session', 'global'],
  studio: ['group', 'global'],
  academy: ['session', 'group', 'global'],
};

/** biz-scope-rules 入参的 duck-typed config 形状（结构化兼容 SessionConfig + PromptCtx.config） */
interface ConfigLike {
  kind?: { biz?: string } | null;
}

/**
 * 从 duck-typed config 解析当前 biz（写侧校验 + 按 biz 渲染共用）。
 * 读 `config.kind.biz`；缺省/未知 biz → 'playground'（与 agent-side-run.ts L95 tier2 兜底一致）。
 *
 * @param config 任意含可选 `kind.biz` 的对象（SessionConfig / PromptCtx.config / tier2 构造的 config 均兼容）
 * @returns 闭合 BizScopeKind 三值之一；MUST NOT 抛错（容忍 kind 缺失，tier2 run 无 kind）
 */
export function resolveBizScopeKind(config: unknown): BizScopeKind {
  const cfg = config as ConfigLike | null | undefined;
  const biz = cfg?.kind?.biz;
  if (biz === 'playground' || biz === 'studio' || biz === 'academy') return biz;
  return 'playground';
}

/**
 * 按 biz 渲染 prompt 用 scope 规则段（agent_profile d) 段 + consolidation {{scope_table}} 消费）。
 * 纯函数，数据源自 AVAILABLE_SCOPES_BY_BIZ；输出含三段：
 *   ① 本 biz 可用层（带配额 20/30/50）
 *   ② 三层语义说明（session=仅本会话/group=本团队/global=跨项目）
 *   ③ 必填规则（scope 必填无默认，不传或传错被拒并告知可用层）
 *
 * @param biz 当前业务场景
 * @returns prompt 文本段（多行）
 */
export function renderScopeTableForPrompt(biz: BizScopeKind): string {
  const scopes = AVAILABLE_SCOPES_BY_BIZ[biz];
  const lines: string[] = [
    `### scope（写入范围）规则`,
    ``,
    `本场景（${biz}）可用 scope 层：`,
    ...scopes.map((s) => `- ${s}：${SCOPE_SEMANTICS[s]}（配额 ${SCOPE_QUOTAS[s]} 条）`),
    ``,
    `三层语义：`,
    ...Object.entries(SCOPE_SEMANTICS).map(([k, v]) => `- ${k} = ${v}`),
    ``,
    `写入时 scope 必填（无默认值）；不传或传了本场景不可用的层会被拒绝并告知可用层。`,
  ];
  return lines.join('\n');
}

/**
 * scope 缺失时的错误文案（写侧 run() 拼 `[invalid_input]` 前缀后返回给 LLM）。
 * 引导 LLM 自修正：列当前 biz 可用层 + 语义 + 示例。
 *
 * @param biz 当前业务场景
 * @returns 错误消息正文（不含前缀）
 */
export function scopeRequiredErrorText(biz: BizScopeKind): string {
  const scopes = AVAILABLE_SCOPES_BY_BIZ[biz];
  const pairs = scopes.map((s) => `${s}（${SCOPE_SEMANTICS[s]}）`).join(' / ');
  return `scope is required for ${biz} (available: ${pairs}). Example: "scope":"${scopes[0]}".`;
}

/**
 * 传了本 biz 不可用 scope 的错误文案（写侧 run() 拼 `[invalid_input]` 前缀后返回给 LLM）。
 * 指出不可用原因 + 本 biz 可用层 + 语义，引导重试。
 *
 * @param biz 当前业务场景
 * @param got LLM 实际传入的非法 scope 值
 * @returns 错误消息正文（不含前缀）
 */
export function scopeUnavailableErrorText(biz: BizScopeKind, got: string): string {
  const scopes = AVAILABLE_SCOPES_BY_BIZ[biz];
  const pairs = scopes.map((s) => `${s}（${SCOPE_SEMANTICS[s]}）`).join(' / ');
  return `scope "${got}" is not available for ${biz} (available: ${pairs}). Choose one of: ${scopes.join(', ')}.`;
}
