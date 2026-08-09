/**
 * buildSessionConfigFromDeps — [v0.0.33.2] studio 分支测试（4 scope config 主干）
 * 参考: specs/tech/version_logs/v0.0.33.2/change_log.md §2.B（取法表）+ §2.G（skill/model）
 *       specs/tech/squad/[P1]session_config_studio.md §3（studio 分支取法表）+ §2（5 字段契约）
 *
 * 覆盖（对齐 task.json T2 tests）：
 *   1. studio leader/mate：systemPrompt + tools（static-by-type）+ skills overlay（[v0.0.113] 替代 D4 交集：
 *      inherit 纯跟全局 / custom overrides 命中·未命中 / workspace 恒生效 R2）+ modelId 回退链 + 5 字段注入
 *   2. studio squad：systemPrompt='' 占位（v0.0.85.ui_opt F3：squad_role mapper 注入 squad_chat.md）
 *      + tools=[send_message] + skills 空（哑路由器无 member → overlay 空）
 *   3. D5 modelId 回退链：bodyOverride ?? session.modelId ?? squad.modelDefault（v0.0.155 起 member.model 已删，见 model-resolver.ts buildFallbackChain）
 *   4. subagent 分支（subAgentConfig）不破坏：systemPrompt 仍落 config.systemPrompt
 *
 * [v0.0.56 hotfix] kind 必传（pos 5）—— 测试构造 SessionKind 注入。
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { AppConfigService } from '../../config/app-config-service';
import { bootstrapBuiltinPlugins } from '../../bootstrap';
import { buildSessionConfigFromDeps, resolveEffort, type StudioSessionContext } from '../session-config';
import { buildRealSessionTypePolicy } from '../../agent/__helpers__/session-type-policy-test-helper';
// [v0.0.56] SessionKind for test kind construction
import { SessionKind } from '@app/shared';
import { ulid } from '../../config/ulid';
import type { SessionHandlerDeps } from '../session';
import type { SquadRecord, MemberRecord } from '../../agent/schema_defs/squad';

// [v0.0.56 hotfix] 测试用 kind helper（pos 5 必传）
const KIND_LEADER = new SessionKind({ biz: 'studio', role: 'leader', derivation: 'parent' });
const KIND_MATE = new SessionKind({ biz: 'studio', role: 'mate', derivation: 'parent' });
const KIND_SQUAD = new SessionKind({ biz: 'studio', role: 'squad', derivation: 'parent' });

let tmpRoot: string;
let deps: SessionHandlerDeps;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-studio-cfg-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  const store = new SessionStore({ crud, fsRoot: tmpRoot });
  const appConfig = new AppConfigService({ root: tmpRoot });
  const bs = await bootstrapBuiltinPlugins(mkdtempSync(join(tmpdir(), 'studio-bs-')));
  // 单 provider 多 model：覆盖 D5 回退链各档（default/member/squad-default/override）
  appConfig.set('providers', 'mock-prov', {
    id: 'mock-prov', name: 'mock', enabled: true, kind: 'mock',
    credential: {},
    models: [
      { modelId: 'mock-model' },
      { modelId: 'member-model' },
      { modelId: 'squad-default' },
      { modelId: 'override-model' },
    ],
  });
  // [v0.0.89 工作块 ③] resolveModel 不静默兜底（PRD §5.1）。
  //   subagent 测试用例（playground biz）走 chat 链需 default_models.chat 命中 mock-model。
  //   studio 测试用例显式传 member.model/squad.modelDefault 不依赖 default_models（studio 不读）。
  appConfig.set('default_models', 'default', { chat: 'mock-model', summary: 'mock-model' });
  deps = { store, agentManager: bs.agentManager, appConfig, pluginManager: bs.pluginManager, contextEngine: bs.contextEngine, dataDir: tmpRoot, sessionTypePolicy: buildRealSessionTypePolicy(tmpRoot) };
});

afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

/** 在 <dataDir>/skills/<name>/SKILL.md 建一个最小 app 层 skill（resolver 默认 enabled=true） */
function writeSkill(name: string, desc = 'd'): void {
  const dir = join(tmpRoot, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`, 'utf8');
}

/** 在 <workspaceDir>/.rocky/skills/<name>/SKILL.md 建一个 workspace 层 skill（scope='workspace'，R2 恒生效） */
function writeWorkspaceSkill(workspaceDir: string, name: string, desc = 'd'): void {
  const dir = join(workspaceDir, '.rocky', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`, 'utf8');
}

/** 造一个 member record（leader/mate 通用，role/tools/skillConfig/model 由入参定） */
//   [v0.0.33.3 step3] systemPrompt 字段已移除（身份正文迁 squad_role mapper）
//   [v0.0.113] skills → skillConfig（overlay 快照，默认 inherit）
function makeMember(over: Partial<MemberRecord> & { role: 'leader' | 'mate' }): MemberRecord {
  return {
    id: ulid(), squadId: 'sq-1', sessionId: ulid(), name: 'alice', role: over.role,
    tools: over.tools ?? [], skillConfig: over.skillConfig ?? { mode: 'inherit', overrides: {} },
    // [v0.0.155] member.model 已硬删（A4）；makeMember 不再写 model 字段
    state: 'deployed',
  };
}

/** 造一个 squad record（modelDefault 由入参定，默认 squad-default；effortDefault 可选） */
function makeSquad(modelDefault = 'squad-default', effortDefault?: 'default' | 'low' | 'high' | 'max'): SquadRecord {
  return {
    id: 'sq-1', name: 'squad', description: '', modelDefault,
    leaderId: 'm-leader', memberIds: ['m-leader'],
    squadChatSessionId: ulid(),
    enableHeartBeat: false,
    ...(effortDefault !== undefined ? { effortDefault } : {}),
  };
}

const toolNames = (tools: unknown) =>
  (tools as Array<{ definition: { name: string } }>).map((t) => t.definition.name);

describe('buildSessionConfigFromDeps — [v0.0.33.2] studio 分支（leader/mate）', () => {
  it('leader：tools = TOOL_POLICY bound（v0.0.48 不再读 member.tools）+ modelId=squad.modelDefault（v0.0.155 不读 member.model）+ 5 字段注入', () => {
    const member = makeMember({ role: 'leader', tools: ['send_message', 'read'] });
    const squad = makeSquad();
    const studioContext: StudioSessionContext = {
      role: 'leader', squadId: 'sq-1', memberId: member.id, member, squad,
    };
    const ws = join(tmpRoot, 'ws', 'leader');
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, KIND_LEADER, ws, undefined, undefined, studioContext,
    );
    // [v0.0.64 P1] systemPrompt = '' 占位（身份正文迁 squad_role mapper；DEFAULT_SYSTEM_PROMPT 删除）
    expect(config.systemPrompt).toBe('');
    // [v0.0.155] modelId 来自 squad.modelDefault（member.model 已删；session.modelId 也未传）
    expect(config.modelId).toBe('squad-default');
    const names = toolNames(config.tools);
    expect(names).toContain('send_message');
    expect(names).toContain('read');
    expect(names).toContain('bash');
    expect(names).toContain('write');
    expect(names).toContain('todo');
    expect(names).not.toContain('task'); // v0.0.237：task/goal/requirement 摘除
    expect(names).not.toContain('goal');
    expect(names).toContain('web_search');
    expect(names).not.toContain('agent');
    expect(config.workdir).toBe(ws);
    expect(config.kind?.role).toBe('leader');
    expect(config.bizType).toBe('studio');
    expect(config.squadId).toBe('sq-1');
    expect(config.memberId).toBe(member.id);
    expect(config.studioContext?.member).toBe(member);
    expect(config.studioContext?.squad).toBe(squad);
  });

  // [v0.0.113] overlay resolve helper：从 config 取 skill name 集
  const skillNamesOf = (config: { skills?: unknown }) =>
    (config.skills as { entries: Array<{ name: string }> }).entries.map((e) => e.name);

  it('mate inherit：L0 含全局 enabled 全部 skill（R1 纯继承，不再 D4 交集为空）', () => {
    writeSkill('sk-alpha');
    writeSkill('sk-beta');
    // inherit（默认 skillConfig）：全局 enabled 全给（app skill 默认 enabled=true）
    const member = makeMember({ role: 'mate', tools: ['send_message'] });
    const studioContext: StudioSessionContext = {
      role: 'mate', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad(),
    };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, KIND_MATE, join(tmpRoot, 'ws'), undefined, undefined, studioContext,
    );
    const names = skillNamesOf(config);
    expect(names).toContain('sk-alpha');
    expect(names).toContain('sk-beta');
  });

  it('mate custom + overrides{name:false}：排除该 skill；未记录的跟全局保留（R1/R3）', () => {
    writeSkill('sk-alpha'); // 全局 enabled
    writeSkill('sk-beta');  // 全局 enabled，overrides 无记录 → 跟全局保留
    const member = makeMember({
      role: 'mate', tools: ['send_message'],
      skillConfig: { mode: 'custom', overrides: { 'sk-alpha': false } },
    });
    const studioContext: StudioSessionContext = {
      role: 'mate', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad(),
    };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, KIND_MATE, join(tmpRoot, 'ws'), undefined, undefined, studioContext,
    );
    const names = skillNamesOf(config);
    expect(names).not.toContain('sk-alpha'); // custom overrides false → 排除
    expect(names).toContain('sk-beta');      // 无记录 → 跟全局 enabled 保留（R3）
  });

  it('mate custom + overrides{name:true}：显式开启该 skill（overlay 快照生效）', () => {
    writeSkill('sk-gamma');
    const member = makeMember({
      role: 'mate', tools: ['send_message'],
      skillConfig: { mode: 'custom', overrides: { 'sk-gamma': true } },
    });
    const studioContext: StudioSessionContext = {
      role: 'mate', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad(),
    };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, KIND_MATE, join(tmpRoot, 'ws'), undefined, undefined, studioContext,
    );
    expect(skillNamesOf(config)).toContain('sk-gamma');
  });

  it('mate custom + overrides{ws-skill:false}：workspace 层 skill 仍恒生效（R2 不受快照影响）', () => {
    const ws = join(tmpRoot, 'ws');
    writeWorkspaceSkill(ws, 'ws-team-skill'); // scope='workspace'
    // custom 且 overrides 试图关掉 workspace skill → 仍必须保留（R2）
    const member = makeMember({
      role: 'mate', tools: ['send_message'],
      skillConfig: { mode: 'custom', overrides: { 'ws-team-skill': false } },
    });
    const studioContext: StudioSessionContext = {
      role: 'mate', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad(),
    };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, KIND_MATE, ws, undefined, undefined, studioContext,
    );
    expect(skillNamesOf(config)).toContain('ws-team-skill'); // R2：workspace 恒生效
  });

  it('[v0.0.48] leader tools = TOOL_POLICY[\'studio-leader\'].bound（ignore member.tools）', () => {
    const member = makeMember({ role: 'leader', tools: [] });
    const studioContext: StudioSessionContext = { role: 'leader', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad() };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, KIND_LEADER, join(tmpRoot, 'ws'), undefined, undefined, studioContext,
    );
    expect(toolNames(config.tools)).toEqual(expect.arrayContaining([
      'send_message', 'team', 'todo',
      'bash', 'read', 'write', 'edit', 'glob', 'grep', 'skill',
      'web_search', 'web_fetch', 'browser',
    ]));
    expect(toolNames(config.tools)).not.toContain('agent');
    expect(toolNames(config.tools)).not.toContain('task'); // v0.0.237：task 摘除
    expect(toolNames(config.tools)).not.toContain('goal');
    expect(toolNames(config.tools)).not.toContain('requirement');
  });

  it('[v0.0.48] mate tools = TOOL_POLICY[\'studio-mate\'].bound（含 agent + 3 web）', () => {
    const member = makeMember({ role: 'mate', tools: [] });
    const studioContext: StudioSessionContext = { role: 'mate', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad() };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, KIND_MATE, join(tmpRoot, 'ws'), undefined, undefined, studioContext,
    );
    const names = toolNames(config.tools);
    expect(names).toContain('agent');
    expect(names).toContain('send_message');
    expect(names).toContain('bash');
    expect(names).toContain('web_search');
    expect(names).not.toContain('task');
    expect(names).not.toContain('goal');
  });

  it('[v0.0.48] mate member.tools 被忽略（v0.0.48 dead）—— tools=[read] 不再限到 read', () => {
    const member = makeMember({ role: 'mate', tools: ['read'] });
    const studioContext: StudioSessionContext = { role: 'mate', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad() };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, KIND_MATE, join(tmpRoot, 'ws'), undefined, undefined, studioContext,
    );
    const names = toolNames(config.tools);
    expect(names).toContain('send_message');
    expect(names).toContain('bash');
    expect(names).toContain('agent');
    // mate bound = 25（v0.0.237 摘 task；含 ask-question，cron 单工具 6 action；+memory 纯读；+presence；+history_search/get_context；+see_image；+computer）
    expect(names.length).toBe(25);
    expect(names).toContain('presence');
  });

  it('[v0.0.48] mate member.tools=[task] 被忽略 —— 仍按 mate bound', () => {
    const member = makeMember({ role: 'mate', tools: ['task'] });
    const studioContext: StudioSessionContext = { role: 'mate', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad() };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, KIND_MATE, join(tmpRoot, 'ws'), undefined, undefined, studioContext,
    );
    const names = toolNames(config.tools);
    // mate bound = 25（v0.0.237 摘 task）
    expect(names.length).toBe(25);
    expect(names).not.toContain('task'); // task 已从 bound 摘除
    expect(names).toContain('send_message');
  });
});

describe('buildSessionConfigFromDeps — studio 分支（squad 哑路由器）', () => {
  it('squad：systemPrompt="" 占位（v0.0.85.ui_opt F3 squad_role mapper 注入）+ tools=[send_message+consolidate 交集 2] + skills 空 + 无 memberId', () => {
    const squad = makeSquad();
    const studioContext: StudioSessionContext = { role: 'squad', squadId: 'sq-1', squad };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, KIND_SQUAD, join(tmpRoot, 'ws'), undefined, undefined, studioContext,
    );
    // [v0.0.85.ui_opt F3] systemPrompt = '' 占位（路由器人设迁 squad_role mapper → squad_chat.md；
    //   与 leader/mate 同链路，对齐架构原则「单一 system prompt 构建链」）
    expect(config.systemPrompt).toBe('');
    // toolBound = [send_message, todo, skill_manage, memory_manage]（v0.0.223 加 todo；
    //   skill_manage/memory_manage 为 consolidate 旁路交集工具，主 run 不主动用）；resolveToolSet 保注册序
    expect(toolNames(config.tools)).toEqual(['skill_manage', 'memory_manage', 'send_message', 'todo']);
    expect((config.skills as { entries: unknown[] }).entries).toEqual([]);
    expect(config.modelId).toBe('squad-default');
    expect(config.kind?.role).toBe('squad');
    expect(config.bizType).toBe('studio');
    expect(config.memberId).toBeUndefined();
    expect(config.studioContext?.squad).toBe(squad);
    expect(config.studioContext?.member).toBeUndefined();
  });
});

describe('buildSessionConfigFromDeps — [v0.0.158] modelId 回退链（session ?? squad.modelDefault；bodyOverride 已删；member.model 已删）', () => {
  // v0.0.158：bodyOverride 参数已整删——原 bodyOverride 命中 case 删除（无 body override 通路）

  it('mate：session.modelId 命中（INV-A1 不读 member.model）', () => {
    const member = makeMember({ role: 'mate' });
    const studioContext: StudioSessionContext = { role: 'mate', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad('squad-default') };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov', modelId: 'member-model' }, KIND_MATE, join(tmpRoot, 'ws'), undefined, undefined, studioContext,
    );
    expect(config.modelId).toBe('member-model');
  });

  it('mate：无 session.modelId → fallback squad.modelDefault（INV-A1 不读 member.model）', () => {
    const member = makeMember({ role: 'mate' });
    const studioContext: StudioSessionContext = { role: 'mate', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad('squad-default') };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, KIND_MATE, join(tmpRoot, 'ws'), undefined, undefined, studioContext,
    );
    expect(config.modelId).toBe('squad-default');
  });
});

describe('buildSessionConfigFromDeps — [round-3 BUG-1 修] subagent 分支 systemPrompt 落 config', () => {
  it('subAgentConfig.systemPrompt 落 config.systemPrompt + kind.isSubagent=true', () => {
    // subagent 走 subAgentConfig 分支（无 studioContext），systemPrompt 必须落 config.systemPrompt
    const kind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'subagent',  });
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, kind, join(tmpRoot, 'ws'),
      'subagent', { systemPrompt: '你是 explorer 子 agent', tools: ['read'], maxIter: 10 }, undefined,
    );
    expect(config.systemPrompt).toBe('你是 explorer 子 agent');
    expect(config.kind?.isSubagent).toBe(true);
    // 非 studio → 不注入 bizType/studioContext
    expect(config.bizType).toBeUndefined();
    expect(config.studioContext).toBeUndefined();
  });
});

describe('buildSessionConfigFromDeps — [round-3 BUG-3 修] studioContext.members 批量透传', () => {
  it('squad：members 批量透传到 config.studioContext.members（reachable_agents/team_roster 派生用）', () => {
    const leader = makeMember({ role: 'leader', name: 'alice-leader' as never });
    const mateA = makeMember({ role: 'mate' });
    const mateB = makeMember({ role: 'mate' });
    const members = [leader, mateA, mateB];
    const squad = makeSquad();
    const studioContext: StudioSessionContext = {
      role: 'squad', squadId: 'sq-1', squad, members,
    };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, KIND_SQUAD, join(tmpRoot, 'ws'),
      undefined, undefined, studioContext,
    );
    expect(config.studioContext?.members).toBe(members);
    expect(config.studioContext?.members).toHaveLength(3);
  });

  it('leader：members 透传（leader 也需见全队 peer；未传 members → 不注入该字段）', () => {
    const member = makeMember({ role: 'leader' });
    const studioContextNoMembers: StudioSessionContext = {
      role: 'leader', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad(),
    };
    const cfg1 = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, KIND_LEADER, join(tmpRoot, 'ws'),
      undefined, undefined, studioContextNoMembers,
    );
    expect(cfg1.studioContext?.members).toBeUndefined();

    const studioWithMembers: StudioSessionContext = {
      role: 'leader', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad(),
      members: [member],
    };
    const cfg2 = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov' }, KIND_LEADER, join(tmpRoot, 'ws'),
      undefined, undefined, studioWithMembers,
    );
    expect(cfg2.studioContext?.members).toEqual([member]);
  });
});

describe('resolveEffort — [v0.0.279] 覆盖链（成员显式 > 团队默认 > 厂商默认）', () => {
  it('①成员显式档 low/high/max → 用之（团队无关）', () => {
    expect(resolveEffort('low', 'max')).toBe('low');
    expect(resolveEffort('high', undefined)).toBe('high');
    expect(resolveEffort('max', 'default')).toBe('max');
  });

  it('②成员 default → 读团队档 low/high/max', () => {
    expect(resolveEffort('default', 'low')).toBe('low');
    expect(resolveEffort('default', 'high')).toBe('high');
    expect(resolveEffort(undefined, 'max')).toBe('max'); // 成员 undefined 同 default 语义
  });

  it('③成员 default + 团队 default/undefined → undefined（厂商默认，encode 不注入）', () => {
    expect(resolveEffort('default', 'default')).toBeUndefined();
    expect(resolveEffort('default', undefined)).toBeUndefined();
    expect(resolveEffort(undefined, undefined)).toBeUndefined();
  });

  it('④非 studio（无 squad）→ 只 session 一层（团队不存在 → 成员 default → undefined）', () => {
    expect(resolveEffort('default', undefined)).toBeUndefined();
  });
});

describe('buildSessionConfigFromDeps — [v0.0.279] effort 覆盖链注入 config.effort（真实 resolveEffort 行为）', () => {
  it('成员显式档 → config.effort = 成员档（不读团队）', () => {
    const member = makeMember({ role: 'mate' });
    const studioContext: StudioSessionContext = {
      role: 'mate', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad('squad-default', 'max'),
    };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov', effort: 'high' }, KIND_MATE, join(tmpRoot, 'ws'), undefined, undefined, studioContext,
    );
    expect(config.effort).toBe('high');
  });

  it('成员 default + 团队档 → config.effort = 团队档', () => {
    const member = makeMember({ role: 'mate' });
    const studioContext: StudioSessionContext = {
      role: 'mate', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad('squad-default', 'low'),
    };
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov', effort: 'default' }, KIND_MATE, join(tmpRoot, 'ws'), undefined, undefined, studioContext,
    );
    expect(config.effort).toBe('low');
  });

  it('成员 default + 团队 default/未设 → config.effort 不注入（undefined，encode 走厂商默认）', () => {
    const member = makeMember({ role: 'mate' });
    // 团队未设 effortDefault（无字段）
    const studioContextNoDefault: StudioSessionContext = {
      role: 'mate', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad('squad-default'),
    };
    const cfg1 = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov', effort: 'default' }, KIND_MATE, join(tmpRoot, 'ws'), undefined, undefined, studioContextNoDefault,
    );
    expect(cfg1.effort).toBeUndefined();
    // 团队显式 'default'
    const studioContextDefault: StudioSessionContext = {
      role: 'mate', squadId: 'sq-1', memberId: member.id, member, squad: makeSquad('squad-default', 'default'),
    };
    const cfg2 = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov', effort: 'default' }, KIND_MATE, join(tmpRoot, 'ws'), undefined, undefined, studioContextDefault,
    );
    expect(cfg2.effort).toBeUndefined();
  });

  it('非 studio（playground 无 squad）→ 成员 default → config.effort 不注入', () => {
    const kind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' });
    const config = buildSessionConfigFromDeps(
      deps, ulid(), { providerId: 'mock-prov', effort: 'default' }, kind, join(tmpRoot, 'ws'),
    );
    expect(config.effort).toBeUndefined();
  });
});
