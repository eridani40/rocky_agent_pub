/**
 * skills 注入配额单测（v0.0.238 分层：workspace→session/group→group/app→global + builtin 殿后不计）
 * 参考: specs/tech/version_logs/v0.0.238/change_plan.md 模块 E + 架构决策 O3
 *       specs/prd/overall/14-prompt-quality-governance.md §14.2.3
 *       app/plugins/builtins/rocky_context/prompt/skills.ts
 *
 * 覆盖：
 *   - 物理层 → 注入层映射（workspace→session / group→group / app→global / builtin 殿后）
 *   - **builtin 恒全量殿后、不计配额**（裁掉破坏基础能力）
 *   - catalog 拼接序 workspace → group → app → builtin（近者优先，修「system→user→agent 方向反」）
 *   - 层内 user→agent + updatedAt 倒序 + name 升序
 *   - 边界（某层 quota<=0 该层空；三层全 0 仅 builtin；app_config 三 key 覆盖；缺失回退 20/30/50）
 */
import { describe, it, expect } from 'vitest';
import SkillsMapper, { selectSkillsByQuota, type SkillRow, type SkillInjectQuotas } from '../skills';
import type { PromptCtx } from '../../types';

/** 三层同配额（方便「全要」场景） */
const Q50: SkillInjectQuotas = { global: 50, session: 50, group: 50 };

/** 造 SkillRow（origin + scope 已派生，方便直接喂 selectSkillsByQuota） */
function row(
  name: string,
  scope: 'builtin' | 'app' | 'workspace' | 'group',
  origin: 'user' | 'agent' = 'user',
  updatedAt?: string,
): SkillRow {
  return { name, description: `desc-${name}`, evolvable: false, scope, origin, updatedAt };
}

describe('selectSkillsByQuota（分层映射 + builtin 殿后不计配额）', () => {
  it('三层 quota<=0 + 无 builtin → 空数组', () => {
    const rows = [row('a', 'app', 'user'), row('b', 'workspace', 'agent')];
    const zero: SkillInjectQuotas = { global: 0, session: 0, group: 0 };
    expect(selectSkillsByQuota(rows, zero)).toEqual([]);
  });

  it('builtin 恒全量殿后不计配额（三层 quota=0 时 builtin 仍注入）', () => {
    const rows = [row('b1', 'builtin'), row('b2', 'builtin')];
    const zero: SkillInjectQuotas = { global: 0, session: 0, group: 0 };
    const out = selectSkillsByQuota(rows, zero);
    expect(out.map((r) => r.name)).toEqual(['b1', 'b2']);
  });

  it('catalog 序 workspace → group → app → builtin（近者优先，修方向反）', () => {
    // 四层各一，均无 updatedAt（name tiebreak 升序在层内；跨层按 catalog 序）
    const rows = [
      row('z-builtin', 'builtin'),
      row('a-app', 'app'),
      row('m-group', 'group'),
      row('k-workspace', 'workspace'),
    ];
    const out = selectSkillsByQuota(rows, Q50);
    expect(out.map((r) => r.name)).toEqual(['k-workspace', 'm-group', 'a-app', 'z-builtin']);
  });

  it('物理层 → 注入层映射：workspace→session / group→group / app→global / builtin 殿后', () => {
    // 各层 3 条（含 user/agent），maxN 全 2 验证各层独立截断 + builtin 全量
    const rows = [
      row('w1', 'workspace', 'user', '2026-07-03T00:00:00.000Z'),
      row('w2', 'workspace', 'user', '2026-07-02T00:00:00.000Z'),
      row('w3', 'workspace', 'user', '2026-07-01T00:00:00.000Z'),
      row('g1', 'group', 'user', '2026-07-03T00:00:00.000Z'),
      row('g2', 'group', 'user', '2026-07-02T00:00:00.000Z'),
      row('a1', 'app', 'user', '2026-07-03T00:00:00.000Z'),
      row('a2', 'app', 'user', '2026-07-02T00:00:00.000Z'),
      row('bi1', 'builtin'),
      row('bi2', 'builtin'),
    ];
    const q: SkillInjectQuotas = { global: 1, session: 2, group: 1 };
    const out = selectSkillsByQuota(rows, q);
    expect(out.map((r) => r.name)).toEqual([
      'w1', 'w2', // session 层 quota=2（workspace 物理层）
      'g1', // group 层 quota=1
      'a1', // global 层 quota=1（app 物理层）
      'bi1', 'bi2', // builtin 殿后全量（不计配额）
    ]);
  });

  it('层内 user→agent + updatedAt 倒序（user 组在前，agent 组在后，各组内独立排）', () => {
    const rows = [
      row('old-u', 'app', 'user', '2026-01-01T00:00:00.000Z'),
      row('new-u', 'app', 'user', '2026-07-01T00:00:00.000Z'),
      row('new-a', 'app', 'agent', '2026-07-01T00:00:00.000Z'),
      row('old-a', 'app', 'agent', '2026-01-01T00:00:00.000Z'),
    ];
    const out = selectSkillsByQuota(rows, Q50);
    // user 组（new-u>old-u）→ agent 组（new-a>old-a）
    expect(out.map((r) => r.name)).toEqual(['new-u', 'old-u', 'new-a', 'old-a']);
  });

  it('updatedAt 缺失 → 该组内最末', () => {
    const rows = [row('no-ts', 'app', 'user'), row('has-ts', 'app', 'user', '2026-01-01T00:00:00.000Z')];
    const out = selectSkillsByQuota(rows, Q50);
    expect(out.map((r) => r.name)).toEqual(['has-ts', 'no-ts']);
  });

  it('tiebreak：同 updatedAt → name 升序（层内组内）', () => {
    const rows = [row('charlie', 'app'), row('alpha', 'app'), row('bravo', 'app')];
    const out = selectSkillsByQuota(rows, Q50);
    expect(out.map((r) => r.name)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('某层 quota<=0 → 该层空，其他层不受影响', () => {
    const rows = [
      row('w1', 'workspace', 'user'),
      row('g1', 'group', 'user'),
      row('a1', 'app', 'user'),
    ];
    // global(app) 层 quota=0
    const q: SkillInjectQuotas = { global: 0, session: 50, group: 50 };
    const out = selectSkillsByQuota(rows, q);
    expect(out.map((r) => r.name)).toEqual(['w1', 'g1']); // app 层的 a1 被截
  });

  it('quota>层总数 → 全要', () => {
    const rows = [row('only', 'app', 'user', '2026-01-01T00:00:00.000Z')];
    expect(selectSkillsByQuota(rows, Q50).map((r) => r.name)).toEqual(['only']);
  });

  it('空源 → 空数组', () => {
    expect(selectSkillsByQuota([], Q50)).toEqual([]);
  });
});

// —— 分组键派生（SkillRow 已在 readSkillEntries 内派生，此处经 map() 端到端验证）——

/** 造 ctx：skills.entries + 可选 appConfig（session.maxSkillInject 等） */
function makeCtx(entries: unknown[], quotas?: Partial<Record<'global' | 'group' | 'session', number>>): PromptCtx {
  const config: Record<string, unknown> = { skills: { entries } };
  if (quotas) {
    const session: Record<string, number> = {};
    if (quotas.global !== undefined) session.maxSkillInject = quotas.global;
    if (quotas.group !== undefined) session.maxSkillInjectGroup = quotas.group;
    if (quotas.session !== undefined) session.maxSkillInjectSession = quotas.session;
    config.appConfig = { get: (g: string, k: string) => (g === 'session' && k === 'default' ? session : undefined), set: () => {} };
  }
  return { config } as unknown as PromptCtx;
}

describe('SkillsMapper.map 分层配额（端到端：scope→origin→catalog）', () => {
  const mapper = new SkillsMapper('test');

  it('scope=builtin → builtin 层殿后（即使无 source，builtin 全量注入且不计配额）', () => {
    const entries = [
      { name: 'builtin-skill', description: '内置', scope: 'builtin' },
      { name: 'user-skill', description: '用户', scope: 'app', source: 'user' },
    ];
    const frag = mapper.map(makeCtx(entries));
    expect(frag).toHaveLength(1);
    const lines = frag[0]!.content.split('\n').filter((l) => l.startsWith('- '));
    // app 层（global 注入层）在 builtin 层前
    expect(lines[0]).toContain('user-skill');
    expect(lines[1]).toContain('builtin-skill');
  });

  it('source=agent → 同层 user 之后（agent 组殿层内末）', () => {
    const entries = [
      { name: 'agent-skill', description: 'a', scope: 'app', source: 'agent' },
      { name: 'user-skill', description: 'u', scope: 'app', source: 'user' },
    ];
    const frag = mapper.map(makeCtx(entries));
    const lines = frag[0]!.content.split('\n').filter((l) => l.startsWith('- '));
    expect(lines[0]).toContain('user-skill');
    expect(lines[1]).toContain('agent-skill');
  });

  it('source 缺省 + scope=app → user 组（global 层）', () => {
    const entries = [{ name: 'plain', description: '无 source 的 app skill', scope: 'app' }];
    const frag = mapper.map(makeCtx(entries));
    expect(frag[0]!.content).toContain('- plain');
  });
});

describe('SkillsMapper.map app_config 分层配额（三 key + 缺失回退 20/30/50）', () => {
  const mapper = new SkillsMapper('test');

  it('maxSkillInject=2（global 层）截断：3 条 app-scope user skill 取前 2', () => {
    const entries = [
      { name: 'alpha', description: 'a', scope: 'app', source: 'user' },
      { name: 'bravo', description: 'b', scope: 'app', source: 'user' },
      { name: 'charlie', description: 'c', scope: 'app', source: 'user' },
    ];
    const frag = mapper.map(makeCtx(entries, { global: 2 }));
    const lines = frag[0]!.content.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('alpha');
    expect(lines[1]).toContain('bravo');
    expect(frag[0]!.content).not.toContain('charlie');
  });

  it('maxSkillInjectSession（session 层）独立截断 workspace skill', () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({
      name: `w${i}`,
      description: 'd',
      scope: 'workspace',
      source: 'user',
    }));
    const frag = mapper.map(makeCtx(entries, { session: 1 }));
    const lines = frag[0]!.content.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(1); // workspace→session 层 quota=1
    expect(lines[0]).toContain('w0'); // name 升序 tiebreak（同无 updatedAt）
  });

  it('maxSkillInjectGroup（group 层）独立截断 group skill', () => {
    const entries = Array.from({ length: 4 }, (_, i) => ({
      name: `g${i}`,
      description: 'd',
      scope: 'group',
      source: 'user',
    }));
    const frag = mapper.map(makeCtx(entries, { group: 2 }));
    const lines = frag[0]!.content.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(2);
  });

  it('maxSkillInject 缺失 → 默认 50（少量 entries 全入选）', () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({
      name: `s${i}`,
      description: 'd',
      scope: 'app',
      source: 'user',
    }));
    const frag = mapper.map(makeCtx(entries));
    const lines = frag[0]!.content.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(3);
  });

  it('app-scope 全截（global=0）+ 无 builtin → 不贡献 fragment', () => {
    const entries = [{ name: 'a', description: 'd', scope: 'app', source: 'user' }];
    expect(mapper.map(makeCtx(entries, { global: 0 }))).toEqual([]);
  });

  it('app-scope 全截（global=0）+ builtin 有 → 仍贡献（builtin 不计配额殿后）', () => {
    const entries = [
      { name: 'a', description: 'd', scope: 'app', source: 'user' },
      { name: 'bi', description: 'built', scope: 'builtin' },
    ];
    const frag = mapper.map(makeCtx(entries, { global: 0 }));
    expect(frag).toHaveLength(1);
    expect(frag[0]!.content).toContain('- bi');
    expect(frag[0]!.content).not.toContain('- a:');
  });

  it('updatedAt 倒序在 map 输出中生效（新 skill 排前）', () => {
    const entries = [
      { name: 'old', description: 'o', scope: 'app', source: 'user', updatedAt: '2026-01-01T00:00:00.000Z' },
      { name: 'new', description: 'n', scope: 'app', source: 'user', updatedAt: '2026-07-01T00:00:00.000Z' },
    ];
    const frag = mapper.map(makeCtx(entries));
    const lines = frag[0]!.content.split('\n').filter((l) => l.startsWith('- '));
    expect(lines[0]).toContain('new');
    expect(lines[1]).toContain('old');
  });
});
