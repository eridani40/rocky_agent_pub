/**
 * mapper 委托 handler 单测（v0.0.22）
 * 参考: specs/tech/version_logs/v0.0.22/change_log.md §8.1
 *       specs/tech/agent/context/[P0]prompt_content_files.md §6
 *
 * 覆盖：map() 返 fragment.content 来自 handler；metadata（id/tier/priority）保持；
 *       动态数据缺失 → 返 []。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { __clearPromptCacheForTests } from '../../../../../server/src/prompts/prompt-handler';
import IdentityMapper from '../identity';
import RulesMapper from '../rules';
import ToolGuidanceMapper from '../tool_guidance';
import SkillsMapper from '../skills';
import ContextFilesMapper from '../context_files';
// memory mapper 走 per-entry dir store 直读（memory-dir-store），不委托 handler；
//   相关测试在 ./memory-mapper.test.ts（覆盖 memory_user / memory_session 两 mapper）
import type { PromptCtx } from '../../types';

function makeCtx(partial: Record<string, unknown>): PromptCtx {
  return { config: partial } as unknown as PromptCtx;
}

describe('IdentityMapper（委托 IdentityHandler）', () => {
  beforeEach(() => __clearPromptCacheForTests());

  it('map() 返单 fragment，metadata 保持（id/tier/priority）', () => {
    const fragments = new IdentityMapper('test').map(makeCtx({}));
    expect(fragments).toHaveLength(1);
    const f = fragments[0]!;
    expect(f.id).toBe('identity');
    expect(f.tier).toBe('stable');
    expect(f.priority).toBe(1000);
  });

  it('fragment.content 来自 handler（含 Rocky 身份句）', () => {
    const fragments = new IdentityMapper('test').map(makeCtx({}));
    expect(fragments[0]!.content).toContain('Rocky');
    expect(fragments[0]!.content.length).toBeGreaterThan(0);
  });

  it('fragment.content 含诚实性红线（research §4.1）', () => {
    const fragments = new IdentityMapper('test').map(makeCtx({}));
    expect(fragments[0]!.content.toLowerCase()).toMatch(/do not fabricate|report uncertainty/);
  });
});

describe('RulesMapper（委托 RulesHandler）', () => {
  beforeEach(() => __clearPromptCacheForTests());

  it('map() 返单 fragment，metadata 保持', () => {
    const fragments = new RulesMapper('test').map(makeCtx({}));
    expect(fragments).toHaveLength(1);
    const f = fragments[0]!;
    expect(f.id).toBe('rules');
    expect(f.tier).toBe('stable');
    expect(f.priority).toBe(800);
  });

  it('fragment.content 来自 handler（3 section header 都在）', () => {
    const fragments = new RulesMapper('test').map(makeCtx({}));
    const c = fragments[0]!.content;
    expect(c).toContain('# Operating Rules');
    expect(c).toContain('# Doing Tasks');
    expect(c).toContain('# Tool Use');
  });

  // [BUG-004] rules.ts 是正向匹配调用方（sessionType === 'leader'|'mate'|'squad' 才落 squad_role 接管）；
  // playground kind.role='rocky' 归一化为 undefined 后同样不命中三者，落通用 rules.md，回归不变
  it("playground（kind.role='rocky'）→ 仍落通用 rules.md（正向匹配调用方回归不变）", () => {
    const fragments = new RulesMapper('test').map(makeCtx({ kind: { role: 'rocky' } }));
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.content).toContain('# Operating Rules');
  });
});

describe('ToolGuidanceMapper（拼 tool_list 传 handler）', () => {
  beforeEach(() => __clearPromptCacheForTests());

  it('config.tools 非空 → map() 返 fragment 含 tool 列表 + # Tool Guidance', () => {
    const ctx = makeCtx({
      tools: [
        { definition: { name: 'read', description: 'read file' } },
        { definition: { name: 'bash', description: 'run cmd' } },
      ],
    });
    const fragments = new ToolGuidanceMapper('test').map(ctx);
    expect(fragments).toHaveLength(1);
    const f = fragments[0]!;
    expect(f.id).toBe('tool_guidance');
    expect(f.tier).toBe('stable');
    expect(f.priority).toBe(600);
    expect(f.content).toContain('# Tool Guidance');
    expect(f.content).toContain('- `read` — read file');
    expect(f.content).toContain('- `bash` — run cmd');
  });

  it('空 tools → 不贡献（空数组）', () => {
    expect(new ToolGuidanceMapper('test').map(makeCtx({ tools: [] }))).toEqual([]);
  });

  it('无 tools 字段 → 不贡献', () => {
    expect(new ToolGuidanceMapper('test').map(makeCtx({}))).toEqual([]);
  });
});

describe('SkillsMapper（拼 skills_list 传 handler）', () => {
  beforeEach(() => __clearPromptCacheForTests());

  it('enabled 项 → 拼 L0 fragment（含 Skills 标题 + name: desc + tool 引导）', () => {
    const ctx = makeCtx({
      skills: {
        entries: [
          { name: 'demo', description: '演示技能' },
          { name: 'code-review', description: '审查代码' },
        ],
      },
    });
    const fragments = new SkillsMapper('test').map(ctx);
    expect(fragments).toHaveLength(1);
    const f = fragments[0]!;
    expect(f.id).toBe('skills');
    expect(f.tier).toBe('stable');
    expect(f.priority).toBe(500);
    expect(f.content).toContain('# Skills');
    // v0.0.55: L0 每条 entry 带 [evolvable=true|false] 标记（skill_definition §2 末段；mutable 改名 evolvable）
    // v0.0.232: 加 [scope=...] 来源层标注（缺省 'app'）
    expect(f.content).toContain('- demo [evolvable=false] [scope=app]: 演示技能');
    expect(f.content).toContain('- code-review [evolvable=false] [scope=app]: 审查代码');
    expect(f.content).toContain('`skill` tool');
  });

  it('空 entries → 不贡献（空数组）', () => {
    expect(new SkillsMapper('test').map(makeCtx({ skills: { entries: [] } }))).toEqual([]);
  });

  it('无 skills 字段 → 不贡献', () => {
    expect(new SkillsMapper('test').map(makeCtx({}))).toEqual([]);
  });

  it('过滤非法 entry（缺 name/description）', () => {
    const ctx = makeCtx({
      skills: {
        entries: [
          { name: 'good', description: 'ok' },
          { name: 'no-desc' },
          { description: 'no-name' },
          null,
          'string',
        ],
      },
    });
    const fragments = new SkillsMapper('test').map(ctx);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.content).toContain('- good [evolvable=false] [scope=app]: ok');
    expect(fragments[0]!.content).not.toContain('no-desc');
  });
});

describe('ContextFilesMapper（委托 ContextFilesHandler）', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-files-mapper-'));
  });
  afterEach(() => fs.rmSync(tmpProject, { recursive: true, force: true }));

  it('cwd 有 AGENTS.md → map() 返 fragment（context tier，含 Project Context 标题）', () => {
    fs.writeFileSync(path.join(tmpProject, 'AGENTS.md'), '# Proj\ncontent');
    const ctx = makeCtx({ workdir: tmpProject });
    const fragments = new ContextFilesMapper('test').map(ctx);
    expect(fragments).toHaveLength(1);
    const f = fragments[0]!;
    expect(f.id).toBe('context_files');
    expect(f.tier).toBe('context');
    expect(f.priority).toBe(400);
    expect(f.content).toContain('# Project Context (AGENTS.md)');
    expect(f.content).toContain(path.join(tmpProject, 'AGENTS.md'));
    expect(f.content).toContain('# Proj');
  });

  it('cwd 字段也生效（workdir 缺失时 fallback）', () => {
    fs.writeFileSync(path.join(tmpProject, 'CLAUDE.md'), 'claude');
    const ctx = makeCtx({ cwd: tmpProject });
    const fragments = new ContextFilesMapper('test').map(ctx);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.content).toContain('CLAUDE.md');
  });

  it('无候选文件 → 不贡献', () => {
    const ctx = makeCtx({ workdir: tmpProject });
    expect(new ContextFilesMapper('test').map(ctx)).toEqual([]);
  });

  it('无 cwd/workdir → 不贡献', () => {
    expect(new ContextFilesMapper('test').map(makeCtx({}))).toEqual([]);
  });
});
