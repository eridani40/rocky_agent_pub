/**
 * skills mapper 单测 — enabled 项拼 L0 fragment 格式（含 evolvable 标记）
 * 参考: specs/tech/agent/skills/[P0]skill_definition.md §2 §6（L0 带 evolvable）
 *       specs/tech/agent/skills/[P0]skill_manage_tool.md §5（L0 vs list 区别）
 *       app/plugins/builtins/rocky_context/prompt/skills.ts
 *
 * mapper 从 ctx.config.skills.entries 读 enabled 项（session-config 已过滤 disabled），
 * 拼 L0 fragment（# Skills + 每条 `name [evolvable=true|false]: description` + tool 引导）。
 * v0.0.55：SkillEntry mutable 改名为 evolvable，L0 标记同步改名（语义不变）。
 *
 * 放本目录（app/plugins/.../prompt/__tests__/）：mapper 实现位于 app/plugins，
 * 不属 app/server/src rootDir，测试就近放置避免跨 workspace rootDir 违规。
 */
import { describe, it, expect } from 'vitest';
import SkillsMapper from '../skills';
import type { PromptCtx } from '../../types';

function makeCtx(entries: unknown[]): PromptCtx {
  return {
    config: { skills: { entries } },
  } as unknown as PromptCtx;
}

describe('SkillsMapper', () => {
  const mapper = new SkillsMapper('test');

  it('空 entries → 不贡献（空数组）', () => {
    expect(mapper.map(makeCtx([]))).toEqual([]);
  });

  it('无 skills 字段 → 不贡献', () => {
    expect(mapper.map({ config: {} } as unknown as PromptCtx)).toEqual([]);
  });

  it('enabled 项 → 拼 L0 fragment（含 Skills 标题 + name [evolvable]: desc + tool 引导）', () => {
    const entries = [
      { name: 'demo', description: '演示技能', evolvable: true },
      { name: 'code-review', description: '审查代码', evolvable: false },
    ];
    const fragments = mapper.map(makeCtx(entries));
    expect(fragments).toHaveLength(1);
    const f = fragments[0]!;
    expect(f.id).toBe('skills');
    expect(f.tier).toBe('stable');
    expect(f.priority).toBe(500);
    expect(f.content).toContain('# Skills');
    // v0.0.55: 每条带 [evolvable=true|false] 标记（mutable 改名为 evolvable）
    // v0.0.232: 加 [scope=...] 来源层标注（缺省 'app'）
    expect(f.content).toContain('- demo [evolvable=true] [scope=app]: 演示技能');
    expect(f.content).toContain('- code-review [evolvable=false] [scope=app]: 审查代码');
    expect(f.content).toContain('`skill` tool');
  });

  it('evolvable 字段缺省时视为 false（§6.3 保守默认 immutable by default）', () => {
    const entries = [{ name: 'no-evolvable-field', description: '无 evolvable 字段' }];
    const fragments = mapper.map(makeCtx(entries));
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.content).toContain('- no-evolvable-field [evolvable=false] [scope=app]: 无 evolvable 字段');
  });

  it('过滤非法 entry（缺 name/description）', () => {
    const entries = [
      { name: 'good', description: 'ok', evolvable: true },
      { name: 'no-desc' }, // 缺 description
      { description: 'no-name' }, // 缺 name
      null,
      'string',
    ];
    const fragments = mapper.map(makeCtx(entries));
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.content).toContain('- good [evolvable=true] [scope=app]: ok');
    expect(fragments[0]!.content).not.toContain('no-desc');
  });

  it('L0 catalog 每条 entry 必带 [evolvable=...] 标记（无遗漏）', () => {
    // 验证 L0 输出严格对齐 skill_definition §2 末段：每条 entry 含 name + description + evolvable
    const entries = [
      { name: 'a', description: 'desc-a', evolvable: true },
      { name: 'b', description: 'desc-b', evolvable: false },
      { name: 'c', description: 'desc-c' /* 缺省 */ },
    ];
    const fragments = mapper.map(makeCtx(entries));
    expect(fragments).toHaveLength(1);
    const content = fragments[0]!.content;
    // 三条都应有 [evolvable=...] 标记
    expect(content).toContain('- a [evolvable=true] [scope=app]: desc-a');
    expect(content).toContain('- b [evolvable=false] [scope=app]: desc-b');
    expect(content).toContain('- c [evolvable=false] [scope=app]: desc-c');
    // 不应出现裸 `: desc` 不带 evolvable 标记的行
    expect(content).not.toMatch(/^[-*] \w+: desc/m);
  });
});
