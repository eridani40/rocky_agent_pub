/**
 * rocky_context plugin v0.0.33.3 squad_role mapper 单测（替代 member.systemPrompt 作身份正文）
 *

 * [v0.0.56] mock session type 迁移：mkCtx 从 sessionType 推导 kind（readSessionType 已改为读 config.kind）。
 * 参考: specs/tech/squad/[P1]prompt_sections.md §3.1（squad_role 固定规范注入）
 *       reqs/v0.0.33.3/req6 §3/§7（system prompt 不落库 + fragment 组装 + 3 步迁移）
 *
 * 覆盖：
 *   1. 4 角色 分流：leader/mate/squad → 对应 content fragment；subagent/standalone → []
 *   2. priority 950 / tier stable
 *   3. content fragment 实际含关键规则字（leader 不直接编码 / mate 不创建 task / squad 永不创作）
 *   4. 无状态：同 mapper 多次 map() 不缓存（content 文件 mtime 由 PromptHandler 管）
 */
import { describe, it, expect } from 'vitest';
import SquadRoleMapper from '../squad_role';

/** [v0.0.56] mock 自动从 sessionType 推导 config.kind（readSessionType → readSessionKind 已切到读 config.kind） */
function mkCtx(overrides: Record<string, unknown> = {}): { config: Record<string, unknown> } {
  const st = overrides.sessionType as string | undefined;
  let kind: { role?: string; isSubagent?: boolean; isStudio?: boolean } | undefined;
  if (st === 'subagent') {
    kind = { isSubagent: true };
  } else if (st === 'leader' || st === 'mate' || st === 'squad') {
    kind = { role: st, isStudio: true };
  }
  const base: Record<string, unknown> = { modelId: 'm' };
  if (kind) base.kind = kind;
  return { config: { ...base, ...overrides } };
}

describe('v0.0.33.3 squad_role mapper（替代 member.systemPrompt 作身份正文）', () => {
  it('leader → 贡献 stable fragment（priority 950，含 leader.md 关键规则）', () => {
    const out = new SquadRoleMapper('squad_role', {}).map(mkCtx({ sessionType: 'leader' }));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('squad_role');
    expect(out[0]!.tier).toBe('stable');
    expect(out[0]!.priority).toBe(950);
    // leader 关键规则：不直接编码 + 协作 + todo/presence 工具链
    expect(out[0]!.content).toMatch(/leader/i);
    expect(out[0]!.content).toMatch(/不直接编码/);
    expect(out[0]!.content).toMatch(/todo/);
  });

  it('mate → 贡献 mate.md fragment（含 mate 关键规则：不越权 / 自己汇报 / reports）', () => {
    const out = new SquadRoleMapper('squad_role', {}).map(mkCtx({ sessionType: 'mate' }));
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toMatch(/mate/i);
    expect(out[0]!.content).toMatch(/不越权/);
    // mate 完成后写 reports + status=done
    expect(out[0]!.content).toMatch(/reports/);
  });

  it('squad → 贡献 squad_chat.md fragment（路由器人设：永不创作内容）', () => {
    const out = new SquadRoleMapper('squad_role', {}).map(mkCtx({ sessionType: 'squad' }));
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toMatch(/SquadChat/);
    expect(out[0]!.content).toMatch(/永不创作内容/);
  });

  it('squad → {{squad_name}} 占位符按 ctx.config.studioContext.squad.name 替换（不再原样 echo）', () => {
    // [v0.0.85.ui_opt F3 fix] LLM 会把 `{squad.name}` 点号 brace 当字面量 echo；
    // 改 {{squad_name}} + mapper 加载期 fillTemplate 注入实际群聊名。
    const out = new SquadRoleMapper('squad_role', {}).map(
      mkCtx({
        sessionType: 'squad',
        studioContext: { squad: { name: 'fwd3-sq-1783359639' } },
      }),
    );
    expect(out).toHaveLength(1);
    // 替换后含实际群聊名
    expect(out[0]!.content).toMatch(/来自群聊 fwd3-sq-1783359639 的转发/);
    // 不再残留原始占位符（防 LLM 原样 echo）
    expect(out[0]!.content).not.toMatch(/\{\{squad_name\}\}/);
    expect(out[0]!.content).not.toMatch(/\{squad\.name\}/);
  });

  it('squad → studioContext.squad.name 缺省时占位符清空（不抛错，降级空串）', () => {
    // 防御：squad chat session 的 studioContext.squad 必填，但代码须对类型 undefined 容错
    const out = new SquadRoleMapper('squad_role', {}).map(mkCtx({ sessionType: 'squad' }));
    expect(out).toHaveLength(1);
    expect(out[0]!.content).not.toMatch(/\{\{squad_name\}\}/);
    expect(out[0]!.content).not.toMatch(/\{squad\.name\}/);
  });

  it('subagent → []（subagent 走 parent_task mapper + IdentityHandler）', () => {
    const out = new SquadRoleMapper('squad_role', {}).map(mkCtx({ sessionType: 'subagent' }));
    expect(out).toEqual([]);
  });

  it('standalone（!sessionType）→ []（走 Rocky identity + 通用 rules.md）', () => {
    const out = new SquadRoleMapper('squad_role', {}).map(mkCtx());
    expect(out).toEqual([]);
  });

  it('无状态：同 mapper 多次 map(leader) 都返非空（content 文件 mtime 由 PromptHandler 管）', () => {
    const mapper = new SquadRoleMapper('squad_role', {});
    const ctx = mkCtx({ sessionType: 'leader' });
    const out1 = mapper.map(ctx);
    const out2 = mapper.map(ctx);
    expect(out1).toHaveLength(1);
    expect(out2).toHaveLength(1);
    expect(out1[0]!.content).toBe(out2[0]!.content);
  });

  // ============================================================
  // [v0.0.142] workStyle 追加段：仅个人 session（leader/mate）注入自己的 workStyle
  // ============================================================

  it('leader + studioContext.member.workStyle 非空 → content 含追加段', () => {
    const out = new SquadRoleMapper('squad_role', {}).map(
      mkCtx({ sessionType: 'leader', studioContext: { member: { workStyle: '喜欢直接给结论，少寒暄' } } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toMatch(/## 我的工作方式/);
    expect(out[0]!.content).toMatch(/喜欢直接给结论，少寒暄/);
  });

  it('mate + studioContext.member.workStyle 非空 → content 含追加段', () => {
    const out = new SquadRoleMapper('squad_role', {}).map(
      mkCtx({ sessionType: 'mate', studioContext: { member: { workStyle: '偏好先写测试再写实现' } } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toMatch(/## 我的工作方式/);
    expect(out[0]!.content).toMatch(/偏好先写测试再写实现/);
  });

  it('leader workStyle 空串/缺省 → content 不含追加段（无悬空标题）', () => {
    const outEmpty = new SquadRoleMapper('squad_role', {}).map(
      mkCtx({ sessionType: 'leader', studioContext: { member: { workStyle: '' } } }),
    );
    expect(outEmpty).toHaveLength(1);
    expect(outEmpty[0]!.content).not.toMatch(/## 我的工作方式/);

    const outMissing = new SquadRoleMapper('squad_role', {}).map(mkCtx({ sessionType: 'leader' }));
    expect(outMissing).toHaveLength(1);
    expect(outMissing[0]!.content).not.toMatch(/## 我的工作方式/);
  });

  it('squad session 带 member.workStyle（防御）→ 不追加（squad 分支不读 member）', () => {
    const out = new SquadRoleMapper('squad_role', {}).map(
      mkCtx({ sessionType: 'squad', studioContext: { squad: { name: 'sq-1' }, member: { workStyle: '不该出现' } } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).not.toMatch(/## 我的工作方式/);
    expect(out[0]!.content).not.toMatch(/不该出现/);
  });
});
