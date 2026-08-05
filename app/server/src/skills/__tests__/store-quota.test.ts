/**
 * skills/store-quota 单测（v0.0.247）—— skill 存储侧分层配额 + 计数 + 检查
 * 参考: specs/tech/version_logs/v0.0.247/change_plan.md skill 子系统 + 核心不变量 1-6
 *       app/server/src/memory/__tests__/inject-quota.test.ts（同模式 UT 对照）
 *
 * 覆盖验收（对应核心不变量）：
 *   - resolveSkillStoreQuotas：无 appConfig / 字段非 finite / 正常值 → 50/30/20 默认 + 覆盖
 *   - countActiveSkillsInScope：disabled 过滤（不变量#2）、builtin 排除（#3）、scope 过滤、
 *     三层（app/workspace/group）独立计数正确、evolvable=false 计入（#4）
 *   - checkSkillStoreQuota：未超 no-op、超限抛 SkillQuotaExceededError（携四字段）、
 *     evolvable=false 计数体现在错误文案
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  resolveSkillStoreQuotas,
  countActiveSkillsInScope,
  checkSkillStoreQuota,
  DEFAULT_SKILL_STORE_QUOTAS,
} from '../store-quota';
import { SkillQuotaExceededError } from '../policy';
import { appSkillRoot, workspaceSkillRoot, groupSkillRoot } from '../resolver';
import { SkillEnabledStore } from '../enabled-store';
import { AppConfigService } from '../../config/app-config-service';

/** 写一个 fixture SKILL.md 到指定 skillDir（绕过 executeCreate，用于计数测试底料） */
function writeFixture(skillDir: string, name: string, evolvable: boolean): void {
  mkdirSync(skillDir, { recursive: true });
  const fm = [
    '---',
    `name: ${name}`,
    `description: fixture for ${name}`,
    `evolvable: ${evolvable}`,
    '---',
    '',
    'body',
  ].join('\n');
  writeFileSync(join(skillDir, 'SKILL.md'), fm, 'utf8');
}

describe('resolveSkillStoreQuotas — 兜底 + 覆盖', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'rocky-skill-q-resolve-')); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('null appConfig → 默认 50/30/20', () => {
    expect(resolveSkillStoreQuotas(null)).toEqual({ global: 50, group: 30, session: 20 });
  });

  it('session record 缺失 → 默认 50/30/20', () => {
    const ac = new AppConfigService({ root: dataDir });
    expect(resolveSkillStoreQuotas(ac)).toEqual({ global: 50, group: 30, session: 20 });
  });

  it('字段非 finite（NaN / string / undefined）→ 各层独立回退默认', () => {
    const ac = new AppConfigService({ root: dataDir });
    ac.set('session', 'default', {
      maxSkillInject: Number.NaN,
      maxSkillInjectGroup: 'not-a-number',
      // maxSkillInjectSession 缺失
    });
    expect(resolveSkillStoreQuotas(ac)).toEqual({ global: 50, group: 30, session: 20 });
  });

  it('正常值覆盖（global=5 / group=8 / session=3）', () => {
    const ac = new AppConfigService({ root: dataDir });
    ac.set('session', 'default', {
      maxSkillInject: 5,
      maxSkillInjectGroup: 8,
      maxSkillInjectSession: 3,
    });
    expect(resolveSkillStoreQuotas(ac)).toEqual({ global: 5, group: 8, session: 3 });
  });

  it('部分覆盖：仅 maxSkillInject=7 → global=7 其他默认', () => {
    const ac = new AppConfigService({ root: dataDir });
    ac.set('session', 'default', { maxSkillInject: 7 });
    expect(resolveSkillStoreQuotas(ac)).toEqual({ global: 7, group: 30, session: 20 });
  });

  it('DEFAULT_SKILL_STORE_QUOTAS = {global:50, group:30, session:20}', () => {
    expect(DEFAULT_SKILL_STORE_QUOTAS).toEqual({ global: 50, group: 30, session: 20 });
  });
});

describe('countActiveSkillsInScope — scope 过滤 + disabled/builtin 排除 + evolvable 计数', () => {
  let dataDir: string;
  let workspace: string;
  let groupWs: string;
  let store: SkillEnabledStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-skill-q-count-'));
    workspace = mkdtempSync(join(tmpdir(), 'rocky-skill-q-ws-'));
    groupWs = mkdtempSync(join(tmpdir(), 'rocky-skill-q-grp-'));
    store = new SkillEnabledStore(new AppConfigService({ root: dataDir }));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(groupWs, { recursive: true, force: true });
  });

  it('app scope：数 app 层 active skill（disabled 不计、builtin 不计）', () => {
    // app 层 3 个 active skill
    writeFixture(join(appSkillRoot(dataDir), 'a1'), 'a1', true);
    writeFixture(join(appSkillRoot(dataDir), 'a2'), 'a2', true);
    writeFixture(join(appSkillRoot(dataDir), 'a3'), 'a3', false); // evolvable=false 计入
    // a2 disabled
    store.setEnabled('a2', false);
    const r = countActiveSkillsInScope('app', dataDir, undefined, undefined, store);
    expect(r.count).toBe(2); // a1 + a3（a2 disabled 不计）
    expect(r.nonEvolvableCount).toBe(1); // a3 evolvable=false
  });

  it('workspace scope：数 workspace 层 active skill（与 app 层互不干扰）', () => {
    // app 层 2 个 + workspace 层 3 个
    writeFixture(join(appSkillRoot(dataDir), 'app-x'), 'app-x', true);
    writeFixture(join(appSkillRoot(dataDir), 'app-y'), 'app-y', true);
    writeFixture(join(workspaceSkillRoot(workspace), 'w1'), 'w1', true);
    writeFixture(join(workspaceSkillRoot(workspace), 'w2'), 'w2', true);
    writeFixture(join(workspaceSkillRoot(workspace), 'w3'), 'w3', false);
    const wsCount = countActiveSkillsInScope('workspace', dataDir, workspace, undefined, store);
    expect(wsCount.count).toBe(3); // 仅 workspace 层
    expect(wsCount.nonEvolvableCount).toBe(1); // w3
    const appCount = countActiveSkillsInScope('app', dataDir, workspace, undefined, store);
    expect(appCount.count).toBe(2); // 仅 app 层（app-x + app-y）
  });

  it('group scope：数 group 层 active skill', () => {
    writeFixture(join(groupSkillRoot(groupWs), 'g1'), 'g1', true);
    writeFixture(join(groupSkillRoot(groupWs), 'g2'), 'g2', false);
    store.setEnabled('g2', false); // disabled 不计
    const r = countActiveSkillsInScope('group', dataDir, undefined, groupWs, store);
    expect(r.count).toBe(1); // 仅 g1（g2 disabled）
    expect(r.nonEvolvableCount).toBe(0); // g2 不计 → 无 evolvable=false
  });

  it('builtin scope 不计入：resolver 返回 builtin 但 filter 排除（不变量#3）', () => {
    // app 层空，仅 builtin 存在（生产 builtin 目录恒有 skill）→ app scope 计数 = 0
    const r = countActiveSkillsInScope('app', dataDir, undefined, undefined, store);
    expect(r.count).toBe(0); // builtin 不计入 app
    expect(r.nonEvolvableCount).toBe(0);
  });

  it('空目录 / 不存在目录 → count=0', () => {
    expect(countActiveSkillsInScope('app', dataDir, undefined, undefined, store)).toEqual({
      count: 0, nonEvolvableCount: 0,
    });
    expect(countActiveSkillsInScope('workspace', dataDir, workspace, undefined, store)).toEqual({
      count: 0, nonEvolvableCount: 0,
    });
    expect(countActiveSkillsInScope('group', dataDir, undefined, groupWs, store)).toEqual({
      count: 0, nonEvolvableCount: 0,
    });
  });

  it('高层覆盖低层：app "dup" 被 workspace 覆盖 → app scope 不计（resolver 合并语义）', () => {
    // app 和 workspace 同名 "dup" → resolver 返回 scope=workspace（高层胜出）
    writeFixture(join(appSkillRoot(dataDir), 'dup'), 'dup', true);
    writeFixture(join(workspaceSkillRoot(workspace), 'dup'), 'dup', true);
    const appCount = countActiveSkillsInScope('app', dataDir, workspace, undefined, store);
    expect(appCount.count).toBe(0); // app 的 dup 被 workspace 覆盖，不计入 app scope
    const wsCount = countActiveSkillsInScope('workspace', dataDir, workspace, undefined, store);
    expect(wsCount.count).toBe(1); // workspace 的 dup 计入
  });
});

describe('checkSkillStoreQuota — 未超 no-op / 超限抛错 + evolvable=false 文案', () => {
  let dataDir: string;
  let store: SkillEnabledStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-skill-q-check-'));
    store = new SkillEnabledStore(new AppConfigService({ root: dataDir }));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('未超限 → no-op（不抛）', () => {
    writeFixture(join(appSkillRoot(dataDir), 'a1'), 'a1', true);
    // limit=5, count=1 → 不抛
    expect(() =>
      checkSkillStoreQuota('app', dataDir, undefined, undefined, store, { global: 5, group: 30, session: 20 }),
    ).not.toThrow();
  });

  it('count==limit → 抛 SkillQuotaExceededError（pre-write count 已达上限）', () => {
    writeFixture(join(appSkillRoot(dataDir), 'a1'), 'a1', true);
    writeFixture(join(appSkillRoot(dataDir), 'a2'), 'a2', true);
    // limit=2, count=2 → 写第 3 个会超 → 抛
    expect(() =>
      checkSkillStoreQuota('app', dataDir, undefined, undefined, store, { global: 2, group: 30, session: 20 }),
    ).toThrow(SkillQuotaExceededError);
  });

  it('超限错误携四字段（scope=current/limit/nonEvolvableCount）+ 文案', () => {
    writeFixture(join(appSkillRoot(dataDir), 'a1'), 'a1', true);
    writeFixture(join(appSkillRoot(dataDir), 'a2'), 'a2', false); // evolvable=false
    let caught: SkillQuotaExceededError | undefined;
    try {
      checkSkillStoreQuota('app', dataDir, undefined, undefined, store, { global: 2, group: 30, session: 20 });
    } catch (e) {
      if (e instanceof SkillQuotaExceededError) caught = e;
    }
    expect(caught).toBeInstanceOf(SkillQuotaExceededError);
    expect(caught!.scope).toBe('global'); // 内部 app → 对外 global
    expect(caught!.current).toBe(2);
    expect(caught!.limit).toBe(2);
    expect(caught!.nonEvolvableCount).toBe(1); // a2 evolvable=false
    expect(caught!.message).toContain('2/2');
    expect(caught!.message).toContain('non-evolvable'); // evolvable=false 提示
    expect(caught!.message).toContain('disable'); // 引导 disable 腾位
  });

  it('workspace scope 超限 → 错误 scope 为 session（对外映射）', () => {
    writeFixture(join(appSkillRoot(dataDir), 'a1'), 'a1', true); // 干扰项（不计入 workspace）
    writeFixture(join(appSkillRoot(dataDir), 'a2'), 'a2', true);
    const ws = mkdtempSync(join(tmpdir(), 'rocky-skill-q-ws-check-'));
    try {
      writeFixture(join(workspaceSkillRoot(ws), 'w1'), 'w1', true);
      writeFixture(join(workspaceSkillRoot(ws), 'w2'), 'w2', true);
      let caught: SkillQuotaExceededError | undefined;
      try {
        checkSkillStoreQuota('workspace', dataDir, ws, undefined, store, { global: 50, group: 30, session: 2 });
      } catch (e) {
        if (e instanceof SkillQuotaExceededError) caught = e;
      }
      expect(caught).toBeInstanceOf(SkillQuotaExceededError);
      expect(caught!.scope).toBe('session'); // 内部 workspace → 对外 session
      expect(caught!.current).toBe(2);
      expect(caught!.limit).toBe(2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('group scope 超限 → 错误 scope 为 group', () => {
    const grp = mkdtempSync(join(tmpdir(), 'rocky-skill-q-grp-check-'));
    try {
      writeFixture(join(groupSkillRoot(grp), 'g1'), 'g1', true);
      writeFixture(join(groupSkillRoot(grp), 'g2'), 'g2', true);
      let caught: SkillQuotaExceededError | undefined;
      try {
        checkSkillStoreQuota('group', dataDir, undefined, grp, store, { global: 50, group: 2, session: 20 });
      } catch (e) {
        if (e instanceof SkillQuotaExceededError) caught = e;
      }
      expect(caught).toBeInstanceOf(SkillQuotaExceededError);
      expect(caught!.scope).toBe('group');
      expect(caught!.current).toBe(2);
    } finally {
      rmSync(grp, { recursive: true, force: true });
    }
  });

  it('全部 evolvable=true → nonEvolvableCount=0，文案无 non-evolvable 提示', () => {
    writeFixture(join(appSkillRoot(dataDir), 'a1'), 'a1', true);
    writeFixture(join(appSkillRoot(dataDir), 'a2'), 'a2', true);
    let caught: SkillQuotaExceededError | undefined;
    try {
      checkSkillStoreQuota('app', dataDir, undefined, undefined, store, { global: 2, group: 30, session: 20 });
    } catch (e) {
      if (e instanceof SkillQuotaExceededError) caught = e;
    }
    expect(caught!.nonEvolvableCount).toBe(0);
    expect(caught!.message).not.toContain('non-evolvable');
  });
});
