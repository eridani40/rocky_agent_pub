/**
 * agent_profile mapper 单测（v0.0.232 「定义你的 agent」section）
 * 参考: specs/tech/agent/context/[P1]agent_profile.md §4（5 kind a/b/c 路径表）
 *       specs/prd/overall/13-agent-definition.md §13.2.1
 *
 * 覆盖：5 kind 渲染（squad leader/mate 双行 + 状态标注、squad 群聊仅团队行、
 *   academy 仅课程行、playground 仅个人行）+ 未覆盖 kind 返 [] + 依赖缺失降级 +
 *   个人文件后缀扫描（member 改名不断链）+ 文案骨架一份 / kind 差异只是数据。
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AgentProfileMapper from '../prompt/agent_profile';

/** 构造 PromptCtx（按需注 kind/sessionContext/studioContext/workdir/dataDir） */
function mkCtx(overrides: Record<string, unknown> = {}): { config: Record<string, unknown> } {
  return { config: { modelId: 'm', client: { contextWindow: 100000 }, ...overrides } };
}

/** kind 纯对象（生产是 SessionKind 实例；mapper 鸭子类型读 biz/role/derivation/runKind） */
function kind(biz: string, role: string, derivation = 'parent', runKind = 'main') {
  return { biz, role, derivation, runKind };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-profile-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const MAPPER = new AgentProfileMapper('agent_profile', {});

describe('agent_profile mapper 5 kind 渲染', () => {
  it('squad leader：团队 + 个人双行均配置，叠加 footer + 3 层 skills', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '# Team');
    mkdirSync(join(tmp, '.rocky', 'agents'), { recursive: true });
    writeFileSync(join(tmp, '.rocky', 'agents', 'Alice-01ABC.md'), '# Alice diff');
    const out = MAPPER.map(
      mkCtx({
        kind: kind('studio', 'leader'),
        sessionContext: { memberId: '01ABC', squadId: 'SQ1' },
        studioContext: { member: { name: 'Alice' } },
        workdir: tmp,
        dataDir: join(tmp, 'data'),
      }),
    );
    expect(out).toHaveLength(1);
    const f = out[0]!;
    expect(f.id).toBe('agent_profile');
    expect(f.tier).toBe('stable');
    expect(f.priority).toBe(480);
    // a 条双行均「已配置」
    expect(f.content).toContain('- 团队 AGENTS.md');
    expect(f.content).toContain('（已配置）');
    expect(f.content).toContain('- 个人 AGENTS.md');
    // 命中后缀文件用实际文件名 Alice-01ABC.md（member 改名不断链）
    expect(f.content).toContain(`agents${'/'}Alice-01ABC.md`);
    // 叠加 footer（squad 专属）
    expect(f.content).toContain('团队在前、个人在后，叠加生效');
    // b 条 squad scope（v0.0.238 按 biz 单源：studio 去 session → group/global）
    expect(f.content).toContain('group（团队级，全队共享） / global');
    // c 条 3 层（workspace 与 group 同址合并「团队」一行）
    expect(f.content).toContain('你的 skills 来自 3 个位置');
    expect(f.content).toContain('- 团队：');
    expect(f.content).toContain('.rocky/skills');
    expect(f.content).toContain('- app：');
    expect(f.content).toContain('- builtin：内置（随 app 发版，只读）');
    // d) 段（v0.0.238 自律治理：4 标准 + scope 规则段，按 biz 渲染）
    expect(f.content).toContain('## d) 自律治理（质量标准）');
    expect(f.content).toContain('1. 分层归位');
    expect(f.content).toContain('4. 会删比会写重要');
    // scope 规则段来自 biz-scope-rules.renderScopeTableForPrompt(studio)
    expect(f.content).toContain('### scope（写入范围）规则');
    expect(f.content).toContain('studio');
    expect(f.content).toContain('配额'); // 含配额 20/30/50
    expect(f.content).toContain('必填'); // scope 必填无默认
  });

  it('squad mate：个人差异未配置 → 引导路径 + 「未配置·可选」', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '# Team');
    // 不建个人差异文件
    const out = MAPPER.map(
      mkCtx({
        kind: kind('studio', 'mate'),
        sessionContext: { memberId: '01ABC' },
        studioContext: { member: { name: 'Bob' } },
        workdir: tmp,
        dataDir: join(tmp, 'data'),
      }),
    );
    const f = out[0]!;
    expect(f.content).toContain('（未配置·可选）');
    // 引导路径用 member.name + memberId
    expect(f.content).toContain(`agents${'/'}Bob-01ABC.md`);
  });

  it('squad 群聊：仅团队行（无个人行）', () => {
    const out = MAPPER.map(
      mkCtx({
        kind: kind('studio', 'squad'),
        sessionContext: { squadId: 'SQ1' },
        workdir: tmp,
        dataDir: join(tmp, 'data'),
      }),
    );
    const f = out[0]!;
    expect(f.content).toContain('- 团队 AGENTS.md');
    expect(f.content).not.toContain('- 个人 AGENTS.md');
  });

  it('academy student：仅课程行，未配置标「未配置」（无 ·可选）', () => {
    const out = MAPPER.map(
      mkCtx({
        kind: kind('academy', 'student'),
        workdir: tmp,
        dataDir: join(tmp, 'data'),
      }),
    );
    const f = out[0]!;
    expect(f.content).toContain('- 课程 AGENTS.md');
    expect(f.content).toContain('（未配置）');
    expect(f.content).not.toContain('未配置·可选');
    // memory scope：academy 三层（v0.0.238 按 biz 单源：academy 加 group）
    expect(f.content).toContain('session / group / global');
    // skills 含 workspace 层（无团队合并）
    expect(f.content).toContain('- workspace：');
    // d) 段按 academy 渲染 scope 表（三层都可用）
    expect(f.content).toContain('academy');
  });

  it('playground rocky：仅个人行（无团队行）', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '# Me');
    const out = MAPPER.map(
      mkCtx({
        kind: kind('playground', 'rocky'),
        workdir: tmp,
        dataDir: join(tmp, 'data'),
      }),
    );
    const f = out[0]!;
    expect(f.content).toContain('- 个人 AGENTS.md');
    expect(f.content).toContain('（已配置）');
    expect(f.content).not.toContain('- 团队 AGENTS.md');
    expect(f.content).not.toContain('团队在前、个人在后');
    // d) 段按 playground 渲染 scope 表（session/global 可用，无 group）
    expect(f.content).toContain('playground');
  });
});

describe('agent_profile 个人文件后缀扫描（member 改名不断链）', () => {
  it('文件名用旧 member 名 + 当前 memberId 后缀 → 仍命中（已配置）', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '# Team');
    mkdirSync(join(tmp, '.rocky', 'agents'), { recursive: true });
    // 旧名文件（member 已改名 Alice→Alicia，但文件名仍带 memberId 后缀）
    writeFileSync(join(tmp, '.rocky', 'agents', 'Alice-01ABC.md'), '# old name diff');
    const out = MAPPER.map(
      mkCtx({
        kind: kind('studio', 'leader'),
        sessionContext: { memberId: '01ABC' },
        studioContext: { member: { name: 'Alicia' } }, // 当前名已改
        workdir: tmp,
        dataDir: join(tmp, 'data'),
      }),
    );
    // 命中后缀文件 → 已配置 + 实际文件名渲染（不是引导路径 Alicia-01ABC.md）
    expect(out[0]!.content).toContain('（已配置）');
    expect(out[0]!.content).toContain(`agents${'/'}Alice-01ABC.md`);
  });

  it('member.name 缺失 → 引导路径回退 `*-{memberId}.md` 后缀锚', () => {
    const out = MAPPER.map(
      mkCtx({
        kind: kind('studio', 'mate'),
        sessionContext: { memberId: '01ABC' },
        // 无 studioContext.member
        workdir: tmp,
        dataDir: join(tmp, 'data'),
      }),
    );
    expect(out[0]!.content).toContain(`agents${'/'}*-01ABC.md`);
  });
});

describe('agent_profile 未覆盖 kind / 降级', () => {
  it('subagent（derivation=subagent）→ []', () => {
    expect(
      MAPPER.map(
        mkCtx({
          kind: kind('studio', 'leader', 'subagent'),
          sessionContext: { memberId: '01ABC' },
          workdir: tmp,
          dataDir: join(tmp, 'data'),
        }),
      ),
    ).toEqual([]);
  });

  it('summary runKind → []', () => {
    expect(
      MAPPER.map(
        mkCtx({
          kind: kind('studio', 'leader', 'parent', 'summary'),
          workdir: tmp,
          dataDir: join(tmp, 'data'),
        }),
      ),
    ).toEqual([]);
  });

  it('academy coach / head_teacher → []', () => {
    expect(
      MAPPER.map(
        mkCtx({ kind: kind('academy', 'coach'), workdir: tmp, dataDir: join(tmp, 'data') }),
      ),
    ).toEqual([]);
    expect(
      MAPPER.map(
        mkCtx({ kind: kind('academy', 'head_teacher'), workdir: tmp, dataDir: join(tmp, 'data') }),
      ),
    ).toEqual([]);
  });

  it('无 kind / 无 workdir → []（不抛错）', () => {
    expect(MAPPER.map(mkCtx({ workdir: tmp }))).toEqual([]);
    expect(
      MAPPER.map(
        mkCtx({ kind: kind('studio', 'leader'), dataDir: join(tmp, 'data') }),
      ),
    ).toEqual([]);
  });

  it('memberId 缺失的 squad leader → 降级仅团队行（不抛错）', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '# Team');
    const out = MAPPER.map(
      mkCtx({ kind: kind('studio', 'leader'), workdir: tmp, dataDir: join(tmp, 'data') }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('- 团队 AGENTS.md');
    expect(out[0]!.content).not.toContain('- 个人 AGENTS.md');
  });
});
