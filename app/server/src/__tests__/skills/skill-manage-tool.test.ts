/**
 * skill_manage 工具单测 — 6 action + evolvable 强制 + payload 无 evolvable + resolveAll 含 disabled
 * 参考: specs/tech/agent/skills/[P0]skill_manage_tool.md §2 §3 §4 §7.2
 *       specs/tech/agent/skills/[P0]skill_definition.md §6（单维度 evolvable 治理）
 *
 * v0.0.55 改名 + 删维度（mutable → evolvable；删 mutableLocked）：
 *   - error 文案 "is non-evolvable (evolvable=false)" 替代 "is immutable (mutable=false)"
 *   - create 注入 3 字段（source/production_method/evolvable=true；删 mutableLocked）
 *
 * 覆盖（acceptance criteria）：
 *   - 6 action（create/patch/disable/enable/list/read）
 *   - evolvable=false 拒绝 patch/disable/enable；evolvable=true 允许
 *   - create 自动写 source=agent/method=consolidation/evolvable=true（3 字段）
 *   - patch payload 不含 evolvable（evolvable 字段不变）
 *   - resolveAll 含 disabled（list 看见 disabled skill）
 *   - 写操作 per-file lock 串行化（withFileLock 复用，间接覆盖）
 *   - payload 不含 evolvable 字段（patch.disable.enable 不可改 evolvable 本身）
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  skillManageTool,
  toInternalSkillScope,
  toExternalSkillScope,
} from '../../tools/skill-manage';
import { appSkillRoot, workspaceSkillRoot } from '../../skills/resolver';
import { SkillResolver } from '../../skills/resolver';
import { SkillEnabledStore } from '../../skills/enabled-store';
import { AppConfigService } from '../../config/app-config-service';
import type { ToolCtx } from '../../tools/types';

/** 构造 ctx：dataDir 必备；workspaceDir 可选（默认 = workdir tmp）；appConfig 可选（v0.0.247 配额测试用） */
function makeCtx(dataDir: string, workdir?: string, appConfig?: AppConfigService): ToolCtx {
  return {
    config: {
      tools: [skillManageTool], dataDir,
      ...(appConfig ? { appConfig } : {}),
    } as unknown as ToolCtx['config'],
    workdir: workdir ?? '/tmp',
  };
}

/** 直读 frontmatter 字段值（简单 regex，避免依赖 gray-matter 类型） */
function fmVal(content: string, key: string): string | undefined {
  const m = new RegExp(`^\\s*${key}\\s*:\\s*['\"]?([\\w-]+)['\"]?\\s*$`, 'm').exec(content);
  return m ? m[1] : undefined;
}

/** 直接写一个 SKILL.md（绕过 skill_manage.create，用于 fixture） */
function writeFixtureSkill(dataDir: string, name: string, evolvable: boolean, body = 'original body'): void {
  const dir = join(appSkillRoot(dataDir), name);
  mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    `name: ${name}`,
    `description: fixture for ${name}`,
    `evolvable: ${evolvable}`,
    '---',
    '',
    body,
  ].join('\n');
  writeFileSync(join(dir, 'SKILL.md'), fm, 'utf8');
}

describe('skill_manage tool', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-skill-manage-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  // ===== action 必填 + dataDir 注入 =====

  it('action 缺失 → INVALID_INPUT', async () => {
    const r = await skillManageTool.run({}, makeCtx(dataDir));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('action is required');
  });

  it('未知 action → INVALID_INPUT', async () => {
    const r = await skillManageTool.run({ action: 'bogus' }, makeCtx(dataDir));
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('unknown action');
  });

  it('ctx.config.dataDir 缺失 → RUNTIME_ERROR', async () => {
    const ctx = { config: { tools: [skillManageTool] }, workdir: '/tmp' } as unknown as ToolCtx;
    const r = await skillManageTool.run({ action: 'list' }, ctx);
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('dataDir missing');
  });

  // ===== create =====

  it('create：写 SKILL.md + 自动注入 3 治理字段（v0.0.55 删 mutableLocked）', async () => {
    const r = await skillManageTool.run(
      { action: 'create', name: 'demo-skill', description: 'demo', body: '# Demo\n\nhello', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(false);
    const skillMd = join(appSkillRoot(dataDir), 'demo-skill', 'SKILL.md');
    expect(existsSync(skillMd)).toBe(true);
    const content = readFileSync(skillMd, 'utf8');
    // 3 治理字段（v0.0.55 删 mutableLocked）
    expect(fmVal(content, 'source')).toBe('agent');
    expect(fmVal(content, 'production_method')).toBe('consolidation');
    expect(fmVal(content, 'evolvable')).toBe('true');
    expect(content).not.toMatch(/^mutableLocked:/m); // 不再注入 mutableLocked
    expect(content).not.toMatch(/^mutable:/m); // 不再用旧名
    // body 落盘
    expect(content).toContain('# Demo');
    expect(content).toContain('hello');
  });

  it('create：同名已存在 → INVALID_INPUT', async () => {
    writeFixtureSkill(dataDir, 'exists-skill', true);
    const r = await skillManageTool.run(
      { action: 'create', name: 'exists-skill', description: 'd', body: 'b', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('already exists');
  });

  it('create：name 非法（非 kebab-case） → INVALID_INPUT', async () => {
    const r = await skillManageTool.run(
      { action: 'create', name: 'Bad_Name', description: 'd', body: 'b', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('invalid skill name');
  });

  it('create：缺 description → INVALID_INPUT', async () => {
    const r = await skillManageTool.run(
      { action: 'create', name: 'no-desc', body: 'b', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('description is required');
  });

  // ===== patch + evolvable 强制 =====

  it('patch：evolvable=true 允许，body 全文替换', async () => {
    writeFixtureSkill(dataDir, 'patchable', true, 'ORIGINAL_BODY');
    const r = await skillManageTool.run(
      { action: 'patch', name: 'patchable', body: '# PATCHED_BODY_NEW', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(false);
    const content = readFileSync(join(appSkillRoot(dataDir), 'patchable', 'SKILL.md'), 'utf8');
    expect(content).toContain('PATCHED_BODY_NEW');
    expect(content).not.toContain('ORIGINAL_BODY');
  });

  it('patch：payload 不含 evolvable → evolvable 字段不变', async () => {
    writeFixtureSkill(dataDir, 'keep-evolvable', true, 'orig');
    await skillManageTool.run(
      { action: 'patch', name: 'keep-evolvable', body: 'new body', scope: 'global' },
      makeCtx(dataDir),
    );
    const content = readFileSync(join(appSkillRoot(dataDir), 'keep-evolvable', 'SKILL.md'), 'utf8');
    expect(fmVal(content, 'evolvable')).toBe('true'); // 仍 true（patch 不改 evolvable）
  });

  it('patch：evolvable=false → 拒绝（spec §4 强制规则；v0.0.55 文案 "non-evolvable"）', async () => {
    writeFixtureSkill(dataDir, 'frozen-skill', false, 'IMMUTABLE_ORIGINAL');
    const r = await skillManageTool.run(
      { action: 'patch', name: 'frozen-skill', body: 'attacked', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('non-evolvable');
    expect((r.content[0] as { text: string }).text).toContain('evolvable=false');
    // body 未被改动
    const content = readFileSync(join(appSkillRoot(dataDir), 'frozen-skill', 'SKILL.md'), 'utf8');
    expect(content).toContain('IMMUTABLE_ORIGINAL');
    expect(content).not.toContain('attacked');
    // evolvable 字段未被改
    expect(fmVal(content, 'evolvable')).toBe('false');
  });

  it('patch：skill 不存在 → NOT_FOUND', async () => {
    const r = await skillManageTool.run(
      { action: 'patch', name: 'ghost', body: 'b', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('not found');
  });

  // ===== disable / enable + evolvable 强制 =====

  it('disable：evolvable=true 允许 → enabled=false', async () => {
    writeFixtureSkill(dataDir, 'toggle-me', true);
    const r = await skillManageTool.run(
      { action: 'disable', name: 'toggle-me', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(false);
    const store = new SkillEnabledStore(new AppConfigService({ root: dataDir }));
    expect(store.isEnabled('toggle-me')).toBe(false);
  });

  it('disable：evolvable=false → 拒绝', async () => {
    writeFixtureSkill(dataDir, 'lock-down', false);
    const r = await skillManageTool.run(
      { action: 'disable', name: 'lock-down', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('non-evolvable');
    // enabled 状态未变（fallback true）
    const store = new SkillEnabledStore(new AppConfigService({ root: dataDir }));
    expect(store.isEnabled('lock-down')).toBe(true);
  });

  it('enable：disable 后 enable 回 true', async () => {
    writeFixtureSkill(dataDir, 'flip', true);
    const store = new SkillEnabledStore(new AppConfigService({ root: dataDir }));
    store.setEnabled('flip', false);
    expect(store.isEnabled('flip')).toBe(false);
    const r = await skillManageTool.run(
      { action: 'enable', name: 'flip', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(false);
    expect(store.isEnabled('flip')).toBe(true);
  });

  it('enable：evolvable=false → 拒绝', async () => {
    writeFixtureSkill(dataDir, 'frozen', false);
    const store = new SkillEnabledStore(new AppConfigService({ root: dataDir }));
    store.setEnabled('frozen', false); // 先 disable（绕过工具）
    const r = await skillManageTool.run(
      { action: 'enable', name: 'frozen', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('non-evolvable');
    expect(store.isEnabled('frozen')).toBe(false); // 状态不变
  });

  // ===== list（含 disabled — 关键设计 §5） =====

  it('list：返全部 skill 元数据（含 disabled + evolvable 字段；无 mutableLocked）', async () => {
    writeFixtureSkill(dataDir, 'visible', true);
    writeFixtureSkill(dataDir, 'hidden', true);
    const store = new SkillEnabledStore(new AppConfigService({ root: dataDir }));
    store.setEnabled('hidden', false);
    const r = await skillManageTool.run({ action: 'list', scope: 'all' }, makeCtx(dataDir));
    expect(r.isError).toBe(false);
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    const names = payload.items.map((m: { name: string }) => m.name);
    expect(names).toContain('visible');
    expect(names).toContain('hidden'); // 关键：disabled 仍出现在 list
    const hidden = payload.items.find((m: { name: string }) => m.name === 'hidden');
    expect(hidden.enabled).toBe(false);
    expect(hidden.evolvable).toBe(true);
    expect(hidden).not.toHaveProperty('mutableLocked'); // v0.0.55 删字段
  });

  it('list：scope=global 只返 global(app) 层，scope 回显 external', async () => {
    writeFixtureSkill(dataDir, 'app-only', true);
    const r = await skillManageTool.run({ action: 'list', scope: 'global' }, makeCtx(dataDir));
    expect(r.isError).toBe(false);
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    expect(payload.items.length).toBeGreaterThan(0);
    // scope 回显 external：内部 app → 对外 global（不变量#1）
    for (const m of payload.items) expect(m.scope).toBe('global');
  });

  // ===== read（含 disabled 全文） =====

  it('read：返回 SKILL.md body 全文', async () => {
    writeFixtureSkill(dataDir, 'reader', true, '# READABLE\n\nfull content here');
    const r = await skillManageTool.run(
      { action: 'read', name: 'reader', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(false);
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    expect(payload.name).toBe('reader');
    expect(payload.body).toContain('# READABLE');
    expect(payload.body).toContain('full content here');
  });

  it('read：含 disabled skill（read 不看 enabled 状态）', async () => {
    writeFixtureSkill(dataDir, 'disabled-but-readable', true, 'DISABLED_BUT_HERE');
    const store = new SkillEnabledStore(new AppConfigService({ root: dataDir }));
    store.setEnabled('disabled-but-readable', false);
    const r = await skillManageTool.run(
      { action: 'read', name: 'disabled-but-readable', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(false);
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    expect(payload.body).toContain('DISABLED_BUT_HERE');
  });

  it('read：skill 不存在 → NOT_FOUND', async () => {
    const r = await skillManageTool.run(
      { action: 'read', name: 'ghost', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('not found');
  });

  // ===== resolveAll（resolver 单独验证 — 含 disabled） =====

  it('resolveAll：返全部 entry（含 disabled）', () => {
    writeFixtureSkill(dataDir, 'r-visible', true);
    writeFixtureSkill(dataDir, 'r-hidden', true);
    const store = new SkillEnabledStore(new AppConfigService({ root: dataDir }));
    store.setEnabled('r-hidden', false);
    const cat = SkillResolver.resolveAll(dataDir, undefined, store);
    const names = cat.entries.map((e) => e.name);
    expect(names).toContain('r-visible');
    expect(names).toContain('r-hidden'); // resolveAll 含 disabled
    const hidden = cat.entries.find((e) => e.name === 'r-hidden');
    expect(hidden?.enabled).toBe(false);
  });

  // ===== 不可 delete（语义：disable 替代；工具无 delete action） =====

  it('无 delete action（disable 替代 delete，spec §3）+ v0.0.166 市场 action', () => {
    // 6 自演化 action + v0.0.166 市场 search/install（skill_market §5/§6）
    const validActions = ['create', 'patch', 'disable', 'enable', 'list', 'read', 'search', 'install'];
    const actionProp = skillManageTool.definition.inputSchema!.properties!['action'] as {
      enum?: string[];
    };
    expect(actionProp.enum).toEqual(validActions);
    expect(actionProp.enum).not.toContain('delete');
  });

  // ===== 并发写：per-file lock 串行化（withFileLock 复用） =====

  it('并发 create 同名：一个成功一个拒绝（per-file lock 串行化）', async () => {
    const ctx = makeCtx(dataDir);
    // 两个并发 create（同名）—— withFileLock 串行化后第二个会撞 already exists
    const [r1, r2] = await Promise.all([
      skillManageTool.run({ action: 'create', name: 'race', description: 'd', body: 'b1', scope: 'global' }, ctx),
      skillManageTool.run({ action: 'create', name: 'race', description: 'd', body: 'b2', scope: 'global' }, ctx),
    ]);
    const errors = [r1, r2].filter((r) => r.isError);
    const oks = [r1, r2].filter((r) => !r.isError);
    expect(errors.length).toBe(1); // 一个被拒
    expect(oks.length).toBe(1); // 一个成功
    expect((errors[0]!.content[0] as { text: string }).text).toContain('already exists');
  });
});

// ===== v0.0.112 scope 边界映射（global/session ↔ app/workspace，输出回显 external，不变量#1） =====

describe('skill_manage scope 边界映射（v0.0.112）', () => {
  let dataDir: string;
  let workspace: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-skill-scope-'));
    workspace = mkdtempSync(join(tmpdir(), 'rocky-skill-ws-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it('toInternalSkillScope：global/缺省→app，session→workspace', () => {
    expect(toInternalSkillScope('global')).toBe('app');
    expect(toInternalSkillScope('session')).toBe('workspace');
    expect(toInternalSkillScope(undefined)).toBe('app'); // 缺省 global→app
    expect(toInternalSkillScope('bogus')).toBe('app'); // 未知归 app
  });

  it('toExternalSkillScope：app/builtin→global，workspace→session', () => {
    expect(toExternalSkillScope('app')).toBe('global');
    expect(toExternalSkillScope('workspace')).toBe('session');
    expect(toExternalSkillScope('builtin')).toBe('global'); // builtin 回显 global
  });

  it('create scope=global：写 app 层 + 输出回显 global', async () => {
    const r = await skillManageTool.run(
      { action: 'create', name: 'g-skill', description: 'd', body: 'b', scope: 'global' },
      makeCtx(dataDir, workspace),
    );
    expect(r.isError).toBe(false);
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    expect(payload.scope).toBe('global'); // 回显 external（内部 app）
    expect(existsSync(join(appSkillRoot(dataDir), 'g-skill', 'SKILL.md'))).toBe(true);
  });

  it('create scope=session：写 workspace 层 + 输出回显 session', async () => {
    const r = await skillManageTool.run(
      { action: 'create', name: 's-skill', description: 'd', body: 'b', scope: 'session' },
      makeCtx(dataDir, workspace),
    );
    expect(r.isError).toBe(false);
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    expect(payload.scope).toBe('session'); // 回显 external（内部 workspace）
    // session→workspace 落 <workspaceDir>/.rocky/skills/
    expect(existsSync(join(workspaceSkillRoot(workspace), 's-skill', 'SKILL.md'))).toBe(true);
    // 未落 app 层
    expect(existsSync(join(appSkillRoot(dataDir), 's-skill', 'SKILL.md'))).toBe(false);
  });

  it('read scope=session：命中 workspace + 输出回显 session', async () => {
    // 先 create 到 session（workspace）
    await skillManageTool.run(
      { action: 'create', name: 'rs-skill', description: 'd', body: '# BODY', scope: 'session' },
      makeCtx(dataDir, workspace),
    );
    const r = await skillManageTool.run(
      { action: 'read', name: 'rs-skill', scope: 'session' },
      makeCtx(dataDir, workspace),
    );
    expect(r.isError).toBe(false);
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    expect(payload.scope).toBe('session'); // 回显 external
    expect(payload.body).toContain('# BODY');
  });

  it('list scope=session：只返 workspace 层，scope 全回显 session', async () => {
    await skillManageTool.run(
      { action: 'create', name: 'ws-only', description: 'd', body: 'b', scope: 'session' },
      makeCtx(dataDir, workspace),
    );
    await skillManageTool.run(
      { action: 'create', name: 'app-one', description: 'd', body: 'b', scope: 'global' },
      makeCtx(dataDir, workspace),
    );
    const r = await skillManageTool.run({ action: 'list', scope: 'session' }, makeCtx(dataDir, workspace));
    expect(r.isError).toBe(false);
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    const names = payload.items.map((m: { name: string }) => m.name);
    expect(names).toContain('ws-only');
    expect(names).not.toContain('app-one'); // global(app) 不在 session 过滤内
    for (const m of payload.items) expect(m.scope).toBe('session');
  });
});

// ===== [v0.0.149] updated 盖戳（注入分组排序用）=====

/** 读 frontmatter ISO 字段值（容忍 : - . 等非 word 字符；fmVal 的 [\w-]+ 抓不全 ISO） */
function fmIso(content: string, key: string): string | undefined {
  const m = new RegExp(`^\\s*${key}\\s*:\\s*['"]?([\\dT:.+-Z]+)['"]?\\s*$`, 'm').exec(content);
  return m ? m[1] : undefined;
}

describe('skill_manage tool [v0.0.149] updated 盖戳', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'rocky-skill-updated-')); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('create：自动盖 updated=now（ISO 时间戳）', async () => {
    const before = Date.now();
    const r = await skillManageTool.run(
      { action: 'create', name: 'stamped', description: 'd', body: 'b', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(false);
    const content = readFileSync(join(appSkillRoot(dataDir), 'stamped', 'SKILL.md'), 'utf8');
    const ts = fmIso(content, 'updated');
    expect(ts).toBeTruthy();
    // 落在 [before, now] 窗口内（盖戳 = 当前时刻）
    const parsed = Date.parse(ts!);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(Date.now());
  });

  it('patch：刷新 updated=now（保留其他 frontmatter 字段）', async () => {
    // fixture 带 updated 旧戳 + description + source
    const dir = join(appSkillRoot(dataDir), 'patch-ts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), [
      '---',
      'name: patch-ts',
      'description: orig',
      'evolvable: true',
      'source: user',
      'updated: 2020-01-01T00:00:00.000Z',
      '---',
      '',
      'old body',
    ].join('\n'), 'utf8');

    const before = Date.now();
    const r = await skillManageTool.run(
      { action: 'patch', name: 'patch-ts', body: 'new body', scope: 'global' },
      makeCtx(dataDir),
    );
    expect(r.isError).toBe(false);
    const content = readFileSync(join(appSkillRoot(dataDir), 'patch-ts', 'SKILL.md'), 'utf8');
    // updated 已刷新为 now（不再是 2020 旧戳）
    const ts = fmIso(content, 'updated');
    expect(ts).toBeTruthy();
    expect(Date.parse(ts!)).toBeGreaterThanOrEqual(before);
    expect(ts).not.toBe('2020-01-01T00:00:00.000Z');
    // 其他字段保留（外科式：不破坏）
    expect(fmVal(content, 'description')).toBe('orig');
    expect(fmVal(content, 'source')).toBe('user');
    expect(fmVal(content, 'evolvable')).toBe('true');
    // body 替换
    expect(content).toContain('new body');
  });
});

// ===== [v0.0.247] 存储配额硬上限（executeCreate 拦截，update/disable 不触发）=====

describe('skill_manage tool [v0.0.247] 存储配额硬上限', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-skill-quota-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  /** 构造带配额的 ctx：maxSkillInject / Group / Session 由 caller 指定 */
  function makeQuotaCtx(
    dir: string,
    quotas: { global?: number; group?: number; session?: number },
  ): { ctx: ToolCtx; appConfig: AppConfigService } {
    const appConfig = new AppConfigService({ root: dir });
    appConfig.set('session', 'default', {
      ...(quotas.global !== undefined ? { maxSkillInject: quotas.global } : {}),
      ...(quotas.group !== undefined ? { maxSkillInjectGroup: quotas.group } : {}),
      ...(quotas.session !== undefined ? { maxSkillInjectSession: quotas.session } : {}),
    });
    return { ctx: makeCtx(dir, undefined, appConfig), appConfig };
  }

  it('create 超 global 配额 → INVALID_INPUT + 文案带 disable 引导', async () => {
    const { ctx } = makeQuotaCtx(dataDir, { global: 1 });
    // 先成功创建 1 个（count=1=limit）
    const r1 = await skillManageTool.run(
      { action: 'create', name: 'first', description: 'd', body: 'b', scope: 'global' },
      ctx,
    );
    expect(r1.isError).toBe(false);
    // 第 2 个 → 拒绝
    const r2 = await skillManageTool.run(
      { action: 'create', name: 'second', description: 'd', body: 'b', scope: 'global' },
      ctx,
    );
    expect(r2.isError).toBe(true);
    const text = (r2.content[0] as { text: string }).text;
    expect(text).toContain('[invalid_input]');
    expect(text).toContain('skill global quota exceeded');
    expect(text).toContain('1/1');
    expect(text).toContain('disable');
  });

  it('executePatch 不触发配额（不变量#1：update 路径不查）', async () => {
    const { ctx } = makeQuotaCtx(dataDir, { global: 1 });
    await skillManageTool.run(
      { action: 'create', name: 'only-one', description: 'd', body: 'orig', scope: 'global' },
      ctx,
    );
    // patch 不被配额拦（虽然 count 已达 limit=1）
    const r = await skillManageTool.run(
      { action: 'patch', name: 'only-one', body: 'PATCHED', scope: 'global' },
      ctx,
    );
    expect(r.isError).toBe(false);
    const content = readFileSync(join(appSkillRoot(dataDir), 'only-one', 'SKILL.md'), 'utf8');
    expect(content).toContain('PATCHED');
  });

  it('disabled skill 不计入配额（不变量#2）', async () => {
    const { ctx } = makeQuotaCtx(dataDir, { global: 1 });
    await skillManageTool.run(
      { action: 'create', name: 'to-disable', description: 'd', body: 'b', scope: 'global' },
      ctx,
    );
    await skillManageTool.run(
      { action: 'disable', name: 'to-disable', scope: 'global' },
      ctx,
    );
    // count=0（disabled 不计）→ 可再创建 1 个
    const r = await skillManageTool.run(
      { action: 'create', name: 'after-disable', description: 'd', body: 'b', scope: 'global' },
      ctx,
    );
    expect(r.isError).toBe(false);
  });

  it('evolvable=false 计入配额 + 错误文案带 non-evolvable 提示（不变量#4）', async () => {
    const { ctx } = makeQuotaCtx(dataDir, { global: 2 });
    // fixture：1 个 evolvable=false skill（计入配额）
    writeFixtureSkill(dataDir, 'frozen', false);
    // create 1 个（evolvable=true）→ count=2=limit
    await skillManageTool.run(
      { action: 'create', name: 'alive', description: 'd', body: 'b', scope: 'global' },
      ctx,
    );
    // 第 3 个 → 拒绝 + non-evolvable 提示
    const r = await skillManageTool.run(
      { action: 'create', name: 'overflow', description: 'd', body: 'b', scope: 'global' },
      ctx,
    );
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('2/2');
    expect(text).toContain('non-evolvable');
    expect(text).toContain('1 non-evolvable'); // 1 条 evolvable=false（frozen）
  });

  it('session 配额独立生效（workspace scope → session 层）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'rocky-skill-quota-ws-'));
    try {
      const appConfig = new AppConfigService({ root: dataDir });
      appConfig.set('session', 'default', { maxSkillInjectSession: 1 });
      const ctx = makeCtx(dataDir, ws, appConfig);
      const r1 = await skillManageTool.run(
        { action: 'create', name: 'ws-1', description: 'd', body: 'b', scope: 'session' },
        ctx,
      );
      expect(r1.isError).toBe(false);
      const r2 = await skillManageTool.run(
        { action: 'create', name: 'ws-2', description: 'd', body: 'b', scope: 'session' },
        ctx,
      );
      expect(r2.isError).toBe(true);
      const text = (r2.content[0] as { text: string }).text;
      expect(text).toContain('skill session quota exceeded');
      expect(text).toContain('1/1');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('并发 create 不同 name（同 scope, limit=1）→ 仅 1 个成功（dir 锁原子性）', async () => {
    const { ctx } = makeQuotaCtx(dataDir, { global: 1 });
    // 两个并发 create（不同 name）—— 无 dir 锁的话两个都会 count=0 通过 → 都写入 → 配额被破
    // 有 dir 锁：串行化 count+write，第二个 count=1>=1 → 拒绝
    const [r1, r2] = await Promise.all([
      skillManageTool.run({ action: 'create', name: 'concurrent-a', description: 'd', body: 'b', scope: 'global' }, ctx),
      skillManageTool.run({ action: 'create', name: 'concurrent-b', description: 'd', body: 'b', scope: 'global' }, ctx),
    ]);
    const oks = [r1, r2].filter((r) => !r.isError);
    const errors = [r1, r2].filter((r) => r.isError);
    expect(oks.length).toBe(1);
    expect(errors.length).toBe(1);
    expect((errors[0]!.content[0] as { text: string }).text).toContain('quota exceeded');
  });

  it('未超限正常创建（配额机制不破坏正常路径）', async () => {
    const { ctx } = makeQuotaCtx(dataDir, { global: 50 }); // 默认值
    const r = await skillManageTool.run(
      { action: 'create', name: 'normal', description: 'd', body: 'b', scope: 'global' },
      ctx,
    );
    expect(r.isError).toBe(false);
    expect(existsSync(join(appSkillRoot(dataDir), 'normal', 'SKILL.md'))).toBe(true);
  });

  it('ctx.config.appConfig 缺失 → 跳过配额检查（向后兼容）', async () => {
    // 不传 appConfig（旧 makeCtx 两参形态）→ ctx.config.appConfig undefined → executeCreate 见 null 不查配额
    const ctx = makeCtx(dataDir);
    const r = await skillManageTool.run(
      { action: 'create', name: 'no-quota', description: 'd', body: 'b', scope: 'global' },
      ctx,
    );
    expect(r.isError).toBe(false);
  });
});
