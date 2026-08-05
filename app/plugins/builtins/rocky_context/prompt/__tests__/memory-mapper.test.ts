/**
 * memory mapper 单测 — 三源读源（v0.0.205 dir store 统一）+ L0 注入的读源 / 边界 / 隔离行为
 * 参考: specs/tech/agent/memory/[P0]memory_injection.md §2（读源表）/§3（L0 注入）/§5（budget_truncate）
 *       specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4
 *       app/plugins/builtins/rocky_context/prompt/memory.ts
 *
 * 与 __tests__/memory-injection-l0.test.ts 的分工：
 *   - memory-injection-l0.test.ts：L0 格式契约（fragment id/tier/priority + `- name: intro`
 *     + 不含 body/why/howToApply + 末尾读正文引导 + archived 跳过 + 全 archived → []）
 *   - 本文件：三源读源（global→<dataDir>/memory/ / session→<workdir>/.rocky/memory/）+ 空/archived 边界
 *     + 介质隔离 + budget_truncate 不裁 stable
 *   两者都断言 **L0 内容（name + intro）**，正文（body/why/howToApply）绝不注入。
 *
 * v0.0.205 读源（统一 per-entry dir store）：
 *   - MemoryUserMapper 读 ctx.config.dataDir（globalMemoryDir(dataDir) = <dataDir>/memory/）
 *   - MemorySessionMapper 读 ctx.config.workdir（wsMemoryDir(workdir) = <workdir>/.rocky/memory/）
 *   - 三源协同：session/group 源读取也要求 dataDir 在场（readMemorySources 单一入口）
 *
 * 文件系统隔离：每个 case 用 os.tmpdir() + mkdtempSync 建临时 dataDir，afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryUserMapper, MemorySessionMapper } from '../memory';
import { AppConfigService } from '../../../../../server/src/config/app-config-service';
import {
  globalMemoryDir,
  wsMemoryDir,
} from '../../../../../server/src/memory/memory-dir-store';
import { writeEntry, archiveEntry } from '../../../../../server/src/memory/memory-dir-write';
import BudgetTruncateReducer from '../budget_truncate';
import TierSortReducer from '../tier_sort';
import type { PromptCtx } from '../../types';

// —— helpers ——

/**
 * 构造 PromptCtx：global 源注 dataDir，session 源注 workdir。
 * 缺省传 undefined 表示该字段未注入。
 */
function makeCtx(opts: {
  appConfig?: AppConfigService;
  dataDir?: string;
  workdir?: string;
  client?: unknown;
}): PromptCtx {
  const config: Record<string, unknown> = {};
  if (opts.appConfig !== undefined) config.appConfig = opts.appConfig;
  if (opts.dataDir !== undefined) config.dataDir = opts.dataDir;
  if (opts.workdir !== undefined) config.workdir = opts.workdir;
  if (opts.client !== undefined) config.client = opts.client;
  return { config } as unknown as PromptCtx;
}

// ============================================================
// MemoryUserMapper — 读 <dataDir>/memory/（global 源）+ L0 边界
// ============================================================

describe('MemoryUserMapper (global 源 / L0 边界)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memory-user-seed-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('dataDir 缺省 → 不贡献（[]）', () => {
    expect(new MemoryUserMapper('test').map(makeCtx({}))).toEqual([]);
  });

  it('dataDir 有但 global 目录空 → 不贡献', () => {
    expect(new MemoryUserMapper('test').map(makeCtx({ dataDir }))).toEqual([]);
  });

  it('多 entry → L0 各 name+intro 全在（不含 body）', async () => {
    await writeEntry(globalMemoryDir(dataDir), { name: 'pref1', intro: 'desc1', type: 'user', body: 'body1' }, {});
    await writeEntry(globalMemoryDir(dataDir), { name: 'pref2', intro: 'desc2', type: 'user', body: 'body2' }, {});
    const content = new MemoryUserMapper('test').map(makeCtx({ dataDir }))[0]!.content;
    // L0：header + `- name: intro` 列表
    expect(content).toContain('# Long-term User Memory');
    expect(content).toContain('- pref1: desc1');
    expect(content).toContain('- pref2: desc2');
    // 正文绝不注入（不变量#5）
    expect(content).not.toContain('body1');
    expect(content).not.toContain('body2');
  });

  it('archived entry 跳过（archive = 移出 active context）', async () => {
    await writeEntry(globalMemoryDir(dataDir), { name: 'active', intro: '活跃', type: 'user', body: 'keep me' }, {});
    await writeEntry(globalMemoryDir(dataDir), { name: 'stale', intro: '过时', type: 'user', body: 'hide me' }, {});
    await archiveEntry(globalMemoryDir(dataDir), 'stale');
    const fragments = new MemoryUserMapper('test').map(makeCtx({ dataDir }));
    expect(fragments).toHaveLength(1);
    const content = fragments[0]!.content;
    expect(content).toContain('- active: 活跃');
    expect(content).not.toContain('stale');
    expect(content).not.toContain('过时');
    // 正文（body）从不注入
    expect(content).not.toContain('keep me');
    expect(content).not.toContain('hide me');
  });

  it('全 archived → 与空目录一致不贡献（[]）', async () => {
    await writeEntry(globalMemoryDir(dataDir), { name: 'a1', intro: 'd1', type: 'user', body: 'b1' }, {});
    await archiveEntry(globalMemoryDir(dataDir), 'a1');
    expect(new MemoryUserMapper('test').map(makeCtx({ dataDir }))).toEqual([]);
  });

  it('budget_truncate 不裁 stable（L0 fragment 完整保留，§5）', async () => {
    // L0 只注入 name+intro（体量极小），stable tier 不被裁，fragment 完整存活
    await writeEntry(globalMemoryDir(dataDir), { name: 'big', intro: 'long', type: 'user', body: 'x'.repeat(500) }, {});
    const ctx = makeCtx({ dataDir, client: { contextWindow: 200000 } });
    const fragments = new MemoryUserMapper('test').map(ctx);
    const sorted = new TierSortReducer('test').reduce(fragments, ctx);
    const truncated = new BudgetTruncateReducer('test').reduce(sorted, ctx);
    expect(truncated).toHaveLength(1);
    expect(truncated[0]!.content).toContain('- big: long');
    // 正文（body 大文本）不在 L0 注入内容里
    expect(truncated[0]!.content).not.toContain('x'.repeat(500));
  });
});

// ============================================================
// MemorySessionMapper — 读 <workdir>/.rocky/memory/（session 源）+ L0 边界
// ============================================================

describe('MemorySessionMapper (session 源 / L0 边界)', () => {
  let dataDir: string;
  let sessionWs: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memory-session-seed-'));
    sessionWs = join(dataDir, 'sess-ws');
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('dataDir 缺省 → 不贡献（三源协同单一入口：无 dataDir 全空）', () => {
    expect(new MemorySessionMapper('test').map(makeCtx({ workdir: sessionWs }))).toEqual([]);
  });

  it('workdir 缺省 → 不贡献（session 源要求 workdir）', () => {
    expect(new MemorySessionMapper('test').map(makeCtx({ dataDir }))).toEqual([]);
  });

  it('dataDir+workdir 有但 memory 目录不存在 → 不贡献', () => {
    expect(new MemorySessionMapper('test').map(makeCtx({ dataDir, workdir: join(dataDir, 'no-such-ws') }))).toEqual([]);
  });

  it('多 entry → L0 各 name+intro 全在（不含 body）', async () => {
    await writeEntry(wsMemoryDir(sessionWs), { name: 'n1', intro: 'd1', type: 'user', body: 'b1' }, {});
    await writeEntry(wsMemoryDir(sessionWs), { name: 'n2', intro: 'd2', type: 'user', body: 'b2' }, {});
    const content = new MemorySessionMapper('test').map(makeCtx({ dataDir, workdir: sessionWs }))[0]!.content;
    expect(content).toContain('# Session Memory');
    expect(content).toContain('- n1: d1');
    expect(content).toContain('- n2: d2');
    // 正文不注入（listMetas 元数据级）
    expect(content).not.toContain('b1');
    expect(content).not.toContain('b2');
  });

  it('archived 跳过', async () => {
    await writeEntry(wsMemoryDir(sessionWs), { name: 'live', intro: 'dl', type: 'user', body: 'keep' }, {});
    await writeEntry(wsMemoryDir(sessionWs), { name: 'dead', intro: 'dd', type: 'user', body: 'gone' }, {});
    await archiveEntry(wsMemoryDir(sessionWs), 'dead');
    const content = new MemorySessionMapper('test').map(makeCtx({ dataDir, workdir: sessionWs }))[0]!.content;
    expect(content).toContain('- live: dl');
    expect(content).not.toContain('dead');
  });

  it('不同 workdir per-session 隔离（互不串扰）', async () => {
    const ws2 = join(dataDir, 'sess-ws-2');
    await writeEntry(wsMemoryDir(sessionWs), { name: 'in-ws1', intro: 'd', type: 'user', body: 'b1' }, {});
    await writeEntry(wsMemoryDir(ws2), { name: 'in-ws2', intro: 'd', type: 'user', body: 'b2' }, {});
    const c1 = new MemorySessionMapper('test').map(makeCtx({ dataDir, workdir: sessionWs }))[0]!.content;
    const c2 = new MemorySessionMapper('test').map(makeCtx({ dataDir, workdir: ws2 }))[0]!.content;
    expect(c1).toContain('in-ws1');
    expect(c1).not.toContain('in-ws2');
    expect(c2).toContain('in-ws2');
    expect(c2).not.toContain('in-ws1');
  });
});

// ============================================================
// global / session 介质隔离（<dataDir>/memory/ vs <workdir>/.rocky/memory/）
// ============================================================

describe('memory_user / memory_session 介质隔离', () => {
  let dataDir: string;
  let sessionWs: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memory-iso-seed-'));
    sessionWs = join(dataDir, 'sess-ws');
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('global 目录有 / session 目录空 → user 贡献 / session 不贡献', async () => {
    await writeEntry(
      globalMemoryDir(dataDir),
      { name: 'u1', intro: 'user-desc', type: 'user', body: 'user-only' },
      {},
    );
    const userFragments = new MemoryUserMapper('test').map(makeCtx({ dataDir }));
    const sessionFragments = new MemorySessionMapper('test').map(makeCtx({ dataDir, workdir: sessionWs }));
    expect(userFragments).toHaveLength(1);
    expect(userFragments[0]!.content).toContain('- u1: user-desc');
    expect(sessionFragments).toEqual([]);
  });

  it('两介质各含不同 entry → 各自注入各自 name（不串）', async () => {
    await writeEntry(
      globalMemoryDir(dataDir),
      { name: 'u-ent', intro: 'user-desc', type: 'user', body: 'user-body' },
      {},
    );
    await writeEntry(
      wsMemoryDir(sessionWs),
      { name: 's-ent', intro: 'session-desc', type: 'project', body: 'session-body' },
      {},
    );
    const u = new MemoryUserMapper('test').map(makeCtx({ dataDir, workdir: sessionWs }))[0]!.content;
    const s = new MemorySessionMapper('test').map(makeCtx({ dataDir, workdir: sessionWs }))[0]!.content;
    expect(u).toContain('- u-ent: user-desc');
    expect(u).not.toContain('s-ent');
    expect(s).toContain('- s-ent: session-desc');
    expect(s).not.toContain('u-ent');
    // 两介质均不注入正文
    expect(u).not.toContain('user-body');
    expect(s).not.toContain('session-body');
  });
});
