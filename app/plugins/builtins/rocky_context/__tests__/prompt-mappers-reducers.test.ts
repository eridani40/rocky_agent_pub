/**
 * rocky_context plugin system_prompt_mapper(6) + reducer(3) 单测
 * 参考: specs/tech/agent/context_and_memory/[P0]system_prompt.md §3/§4
 *       specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.4/§3.5/§4.5
 *
 * 覆盖：
 *   - mapper(6)：identity/rules/tool_guidance/skills/context_files/memory
 *     · identity/rules 贡献 stable fragment
 *     · tool_guidance 读 config.tools；无 tools → 空贡献
 *     · skills/memory [D1.1] no-op → 空贡献
 *     · context_files 读 cwd 下 AGENTS.md；无文件 → 空贡献
 *   - reducer(3)：tier_sort / dedup / budget_truncate（阈值边界）
 *   - memory/todo no-op [D1.1] 单测覆盖
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import IdentityMapper from '../prompt/identity';
import RulesMapper from '../prompt/rules';
import ToolGuidanceMapper from '../prompt/tool_guidance';
import SkillsMapper from '../prompt/skills';
import ContextFilesMapper from '../prompt/context_files';
import { MemoryUserMapper, MemorySessionMapper } from '../prompt/memory';
import TierSortReducer from '../prompt/tier_sort';
import DedupReducer from '../prompt/dedup';
import BudgetTruncateReducer from '../prompt/budget_truncate';

function mkCtx(overrides: Record<string, unknown> = {}): { config: Record<string, unknown> } {
  return { config: { modelId: 'm', client: { contextWindow: 100000 }, ...overrides } };
}

describe('system_prompt_mapper', () => {
  it('identity 贡献 stable fragment 含 "Rocky"', () => {
    const out = new IdentityMapper('identity', {}).map(mkCtx());
    expect(out).toHaveLength(1);
    expect(out[0]!.tier).toBe('stable');
    expect(out[0]!.content).toMatch(/Rocky/i);
    expect(out[0]!.priority).toBe(1000);
  });

  it('rules 贡献 stable fragment', () => {
    const out = new RulesMapper('rules', {}).map(mkCtx());
    expect(out).toHaveLength(1);
    expect(out[0]!.tier).toBe('stable');
    expect(out[0]!.priority).toBe(800);
  });

  it('tool_guidance 读 config.tools → 贡献 stable fragment 列工具', () => {
    const tools = [
      {
        definition: { name: 'bash', description: 'run shell' },
      },
      { definition: { name: 'read_file' } },
    ];
    const out = new ToolGuidanceMapper('tool_guidance', {}).map(mkCtx({ tools }));
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('bash');
    expect(out[0]!.content).toContain('read_file');
    expect(out[0]!.tier).toBe('stable');
  });

  it('tool_guidance 无 tools → 空贡献', () => {
    const out = new ToolGuidanceMapper('tool_guidance', {}).map(mkCtx());
    expect(out).toEqual([]);
  });

  it('skills [D1.1] no-op → 空贡献', () => {
    const out = new SkillsMapper('skills', {}).map(mkCtx());
    expect(out).toEqual([]);
  });

  // [v0.0.51] memory mapper 拆 memory_user + memory_session（无 dataDir → 空贡献）
  it('memory_user [D1.1] no-op → 空贡献', () => {
    const out = new MemoryUserMapper('memory_user', {}).map(mkCtx());
    expect(out).toEqual([]);
  });
  it('memory_session [D1.1] no-op → 空贡献', () => {
    const out = new MemorySessionMapper('memory_session', {}).map(mkCtx());
    expect(out).toEqual([]);
  });

  describe('context_files', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'rocky-context-files-'));
    });
    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it('cwd 下有 AGENTS.md → 贡献 context fragment', () => {
      writeFileSync(join(tmp, 'AGENTS.md'), '# Project\nrules here');
      const out = new ContextFilesMapper('context_files', {}).map(
        mkCtx({ workdir: tmp }),
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.tier).toBe('context');
      expect(out[0]!.content).toContain('rules here');
    });

    it('cwd 下无 AGENTS.md/CLAUDE.md → 空贡献', () => {
      const out = new ContextFilesMapper('context_files', {}).map(
        mkCtx({ workdir: tmp }),
      );
      expect(out).toEqual([]);
    });

    it('无 workdir/cwd → 空贡献', () => {
      const out = new ContextFilesMapper('context_files', {}).map(mkCtx());
      expect(out).toEqual([]);
    });

    // v0.0.232 两级注入（团队 + 个人差异文件）
    it('studio leader：团队 + 个人差异文件都存在 → 两段正文，团队在前', () => {
      writeFileSync(join(tmp, 'AGENTS.md'), '# Team rules');
      mkdirSync(join(tmp, '.rocky', 'agents'), { recursive: true });
      writeFileSync(join(tmp, '.rocky', 'agents', 'Alice-01ABC.md'), '# Alice diff');
      const out = new ContextFilesMapper('context_files', {}).map(
        mkCtx({
          kind: { biz: 'studio', role: 'leader', derivation: 'parent', runKind: 'main' },
          sessionContext: { memberId: '01ABC' },
          workdir: tmp,
        }),
      );
      expect(out).toHaveLength(1);
      const content = out[0]!.content;
      // 团队段在前、个人段在后
      const teamIdx = content.indexOf('Team rules');
      const personalIdx = content.indexOf('Alice diff');
      expect(teamIdx).toBeGreaterThan(-1);
      expect(personalIdx).toBeGreaterThan(-1);
      expect(teamIdx).toBeLessThan(personalIdx);
      // 两段各带来源路径标注
      expect(content).toContain('来自本会话工作目录');
      expect(content).toContain('来自个人差异文件');
      expect(content).toContain('Alice-01ABC.md');
    });

    it('个人差异文件按 *-{memberId}.md 后缀扫描（member 改名不断链）', () => {
      writeFileSync(join(tmp, 'AGENTS.md'), '# Team');
      mkdirSync(join(tmp, '.rocky', 'agents'), { recursive: true });
      // 旧名文件（member 已改名），后缀仍带 memberId
      writeFileSync(join(tmp, '.rocky', 'agents', 'OldName-01ABC.md'), '# old diff');
      const out = new ContextFilesMapper('context_files', {}).map(
        mkCtx({
          kind: { biz: 'studio', role: 'mate', derivation: 'parent', runKind: 'main' },
          sessionContext: { memberId: '01ABC' },
          studioContext: { member: { name: 'NewName' } },
          workdir: tmp,
        }),
      );
      expect(out[0]!.content).toContain('OldName-01ABC.md');
      expect(out[0]!.content).toContain('# old diff');
    });

    it('仅个人差异文件存在（团队 AGENTS.md 缺）→ 只个人段注入', () => {
      mkdirSync(join(tmp, '.rocky', 'agents'), { recursive: true });
      writeFileSync(join(tmp, '.rocky', 'agents', 'Alice-01ABC.md'), '# Alice only');
      const out = new ContextFilesMapper('context_files', {}).map(
        mkCtx({
          kind: { biz: 'studio', role: 'leader', derivation: 'parent', runKind: 'main' },
          sessionContext: { memberId: '01ABC' },
          workdir: tmp,
        }),
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.content).toContain('Alice only');
      expect(out[0]!.content).not.toContain('来自本会话工作目录');
    });

    it('非 studio leader/mate（playground）→ 维持单份读取（个人差异文件不注入）', () => {
      writeFileSync(join(tmp, 'AGENTS.md'), '# Me');
      mkdirSync(join(tmp, '.rocky', 'agents'), { recursive: true });
      writeFileSync(join(tmp, '.rocky', 'agents', 'Alice-01ABC.md'), '# should NOT inject');
      const out = new ContextFilesMapper('context_files', {}).map(
        mkCtx({
          kind: { biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'main' },
          sessionContext: { memberId: '01ABC' },
          workdir: tmp,
        }),
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.content).toContain('# Me');
      expect(out[0]!.content).not.toContain('should NOT inject');
    });
  });

  // v0.0.232 skills L0 加 [scope=...] 来源层标注
  it('skills entries 带 scope → L0 行含 [scope=...] 标注', () => {
    const entries = [
      { name: 'bash', description: 'run shell', enabled: true, scope: 'builtin' },
      { name: 'my-skill', description: 'custom', enabled: true, scope: 'workspace' },
    ];
    const out = new SkillsMapper('skills', {}).map(
      mkCtx({ skills: { entries } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('[scope=builtin]');
    expect(out[0]!.content).toContain('[scope=workspace]');
    // 既有 evolvable 标注仍保留
    expect(out[0]!.content).toContain('[evolvable=');
  });
});

describe('system_prompt_reducer', () => {
  it('tier_sort：stable→context→volatile；tier 内 priority 降序', () => {
    const r = new TierSortReducer('tier_sort', {});
    const input = [
      { id: 'v1', tier: 'volatile', content: 'v1', priority: 100 },
      { id: 's2', tier: 'stable', content: 's2', priority: 50 },
      { id: 's1', tier: 'stable', content: 's1', priority: 100 },
      { id: 'c1', tier: 'context', content: 'c1', priority: 100 },
    ];
    const out = r.reduce(input, mkCtx());
    // stable 优先，tier 内 priority 降序：s1(100) → s2(50) → c1 → v1
    expect(out.map((f) => f.id)).toEqual(['s1', 's2', 'c1', 'v1']);
  });

  it('dedup：同 id 保留首条（=priority 最高者，经 tier_sort 后）', () => {
    const r = new DedupReducer('dedup', {});
    const input = [
      { id: 'x', tier: 'stable', content: 'first', priority: 100 },
      { id: 'x', tier: 'stable', content: 'second', priority: 50 },
      { id: 'y', tier: 'stable', content: 'y', priority: 10 },
    ];
    const out = r.reduce(input, mkCtx());
    expect(out).toHaveLength(2);
    expect(out[0]!.content).toBe('first'); // 保留首条不拼接
  });

  describe('budget_truncate', () => {
    it('未超阈值 → 不动（全保留 stable + 动态）', () => {
      const r = new BudgetTruncateReducer('budget_truncate', {
        budgetFraction: 0.5,
        floor: 1,
        ceiling: 100000,
      });
      const input = [
        { id: 's', tier: 'stable', content: 'stable-content' },
        { id: 'c', tier: 'context', content: 'ctx' },
      ];
      const out = r.reduce(input, mkCtx({ client: { contextWindow: 100 } }));
      expect(out.map((f) => f.id)).toEqual(['s', 'c']);
    });

    it('超阈值 → 只裁动态段尾部，保留 stable 全部 + 动态头部', () => {
      // budget = 100*0.5 = 50；floor=1 ceiling=100000 → budget=50
      const r = new BudgetTruncateReducer('budget_truncate', {
        budgetFraction: 0.5,
        floor: 1,
        ceiling: 100000,
      });
      const input = [
        { id: 's', tier: 'stable', content: 's'.repeat(1000) }, // stable 全保留
        { id: 'c1', tier: 'context', content: 'c'.repeat(30) }, // 30 <= 50 保留
        { id: 'c2', tier: 'context', content: 'c'.repeat(30) }, // 30 + 30 > 50 裁掉
      ];
      const out = r.reduce(input, mkCtx({ client: { contextWindow: 100 } }));
      const ids = out.map((f) => f.id);
      expect(ids).toContain('s');
      expect(ids).toContain('c1');
      expect(ids).not.toContain('c2');
      expect(ids).toContain('budget_truncate_note');
    });

    // v0.0.232 截断标记含全部 dropped fragment id
    it('超阈值裁多个 → note 含全部 dropped id 列表', () => {
      // budget = 100*0.5 = 50；c1 放下后超，c2/c3 全丢
      const r = new BudgetTruncateReducer('budget_truncate', {
        budgetFraction: 0.5,
        floor: 1,
        ceiling: 100000,
      });
      const input = [
        { id: 's', tier: 'stable', content: 's'.repeat(1000) },
        { id: 'c1', tier: 'context', content: 'c'.repeat(40) }, // 40 <= 50 保留
        { id: 'c2', tier: 'context', content: 'c'.repeat(20) }, // 40+20 > 50 第一个放下不下
        { id: 'c3', tier: 'context', content: 'c'.repeat(10) }, // break 后剩余也丢
      ];
      const out = r.reduce(input, mkCtx({ client: { contextWindow: 100 } }));
      const note = out.find((f) => f.id === 'budget_truncate_note');
      expect(note).toBeDefined();
      expect(note!.content).toContain('dropped: c2, c3');
      expect(out.map((f) => f.id)).toContain('c1');
    });

    it('cfg 缺省 = 0.06/20000/500000', () => {
      const r = new BudgetTruncateReducer('budget_truncate', {});
      // contextWindow=1000000 → 0.06*1e6=60000，clamp 到 ceiling=500000
      const out = r.reduce(
        [{ id: 's', tier: 'stable', content: 's' }],
        mkCtx({ client: { contextWindow: 1000000 } }),
      );
      // stable 全保留，无动态段超阈值
      expect(out).toHaveLength(1);
    });
  });
});
