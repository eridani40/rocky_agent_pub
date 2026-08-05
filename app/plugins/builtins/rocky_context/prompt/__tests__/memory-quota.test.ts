/**
 * memory 两 mapper 协同配额截断单测（v0.0.205 存储统一后：global/session 两源）
 * 参考: specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4
 *       app/plugins/builtins/rocky_context/prompt/memory.ts
 *
 * 覆盖：
 *   - 两 mapper 都读两源、调同一纯函数、同输入同输出（协同 invariant）
 *   - maxMemoryInject 读取（appConfig.get('session','default')?.maxMemoryInject ?? 50）
 *   - 四类全局顺序在两 mapper 输出中协同体现（user mapper 出 global 切片 / session mapper 出 session 切片）
 *   - 跨 scope 截断：session 占额时 user mapper 不贡献；反之亦然
 *   - maxMemoryInject=0 → 两 mapper 均不贡献
 *
 * 与 memory-mapper.test.ts 的分工：memory-mapper.test.ts 覆盖单源边界（L0 格式 + archived 跳过 +
 * budget_truncate 不裁 stable）；本文件专测两源协同 + 配额截断。
 *
 * 文件系统隔离：os.tmpdir() + mkdtempSync 建临时 dataDir，afterEach 清理。
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
import { writeEntry } from '../../../../../server/src/memory/memory-dir-write';
import type { PromptCtx } from '../../types';

// —— helpers ——

/**
 * 构造 PromptCtx：两源都注入（appConfig + dataDir + workdir）+ 可选 maxMemoryInject。
 * session 源由 config.workdir 派生（wsMemoryDir(workdir)），global 源由 dataDir 派生。
 */
function makeCtx(opts: {
  appConfig: AppConfigService;
  dataDir: string;
  workdir?: string;
}): PromptCtx {
  const config: Record<string, unknown> = {
    appConfig: opts.appConfig,
    dataDir: opts.dataDir,
  };
  if (opts.workdir !== undefined) config.workdir = opts.workdir;
  return { config } as unknown as PromptCtx;
}

/** 设 memory 分层配额（写 app_config session group 三 key） */
function setMemoryQuotas(
  appConfig: AppConfigService,
  q: Partial<{ global: number; session: number; group: number }>,
): void {
  const patch: Record<string, number> = {};
  if (q.global !== undefined) patch.maxMemoryInject = q.global;
  if (q.session !== undefined) patch.maxMemoryInjectSession = q.session;
  if (q.group !== undefined) patch.maxMemoryInjectGroup = q.group;
  appConfig.set('session', 'default', patch);
}

/** 取 fragment content 中的 `- name` 行（剥 header/hint） */
function entryLines(content: string): string[] {
  return content.split('\n').filter((l) => l.startsWith('- '));
}

// ============================================================
// 两 mapper 协同（协同 invariant：同输入同输出）
// ============================================================

describe('memory 两 mapper 协同', () => {
  let dataDir: string;
  let appConfig: AppConfigService;
  let sessionWs: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memory-quota-user-'));
    appConfig = new AppConfigService({ root: dataDir });
    sessionWs = join(dataDir, 'sess-ws');
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('两源均有 → 两 mapper 均贡献，且各自只输出本 scope 切片（不串扰）', async () => {
    // global 源 1 条（手动）+ session 源 1 条（自动）；maxN 默认 50，全要
    await writeEntry(
      globalMemoryDir(dataDir),
      { name: 'u-pref', intro: 'user-desc', type: 'user', body: 'ub' },
      { source: 'user' },
    );
    await writeEntry(
      wsMemoryDir(sessionWs),
      { name: 's-note', intro: 'session-desc', type: 'user', body: 'sb' },
      {},
    );

    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs });
    const userFrag = new MemoryUserMapper('test').map(ctx);
    const sessionFrag = new MemorySessionMapper('test').map(ctx);

    expect(userFrag).toHaveLength(1);
    expect(sessionFrag).toHaveLength(1);
    expect(userFrag[0]!.content).toContain('- u-pref: user-desc');
    expect(userFrag[0]!.content).not.toContain('s-note');
    expect(sessionFrag[0]!.content).toContain('- s-note: session-desc');
    expect(sessionFrag[0]!.content).not.toContain('u-pref');
  });

  it('同输入同输出：两 mapper 调同一纯函数，selection 无分歧（跨 scope 拆分互补）', async () => {
    // global 手动 1 + global 自动 1（global 组内顺序：手动优先于自动）
    // + session 1（writeEntry 默认 source='agent' → session-agent 组）
    // maxN=50 → 全要
    await writeEntry(globalMemoryDir(dataDir), { name: 'um', intro: 'i', type: 'user', body: 'b' }, { source: 'user' });
    await writeEntry(globalMemoryDir(dataDir), { name: 'ua', intro: 'i', type: 'user', body: 'b' }, { source: 'agent' });
    await writeEntry(wsMemoryDir(sessionWs), { name: 'sm', intro: 'i', type: 'user', body: 'b' }, {});

    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs });
    const userLines = entryLines(new MemoryUserMapper('test').map(ctx)[0]!.content);
    const sessionLines = entryLines(new MemorySessionMapper('test').map(ctx)[0]!.content);

    // user mapper 只出 global 切片（um 在 ua 前——同 scope 内手动优先于自动）
    expect(userLines.map((l) => l.split(':')[0].trim().slice(2))).toEqual(['um', 'ua']);
    // session mapper 只出 session 切片（不串扰 global 切片）
    expect(sessionLines.map((l) => l.split(':')[0].trim().slice(2))).toEqual(['sm']);
  });

  it('各 scope 独立截断：global 配额不影响 session（v0.0.238 分层）', async () => {
    // 3 session entries + 1 global entry；global=2、session=50 → 两 mapper 各取自己层
    await writeEntry(wsMemoryDir(sessionWs), { name: 's1', intro: 'i', type: 'user', body: 'b' }, {});
    await writeEntry(wsMemoryDir(sessionWs), { name: 's2', intro: 'i', type: 'user', body: 'b' }, {});
    await writeEntry(wsMemoryDir(sessionWs), { name: 's3', intro: 'i', type: 'user', body: 'b' }, {});
    await writeEntry(globalMemoryDir(dataDir), { name: 'u1', intro: 'i', type: 'user', body: 'b' }, { source: 'user' });

    setMemoryQuotas(appConfig, { global: 2, session: 50 });
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs });

    // session mapper 出 3 条（session 层独立配额 50）；user mapper 出 1 条（global 层 2，仅 1 条）
    expect(entryLines(new MemorySessionMapper('test').map(ctx)[0]!.content)).toHaveLength(3);
    expect(entryLines(new MemoryUserMapper('test').map(ctx)[0]!.content)).toHaveLength(1);
  });

  it('session 层 quota=1 截断 + global 层独立（不抢占）', async () => {
    await writeEntry(wsMemoryDir(sessionWs), { name: 'sm1', intro: 'i', type: 'user', body: 'b' }, {});
    await writeEntry(wsMemoryDir(sessionWs), { name: 'sm2', intro: 'i', type: 'user', body: 'b' }, {});
    await writeEntry(globalMemoryDir(dataDir), { name: 'um1', intro: 'i', type: 'user', body: 'b' }, { source: 'user' });

    setMemoryQuotas(appConfig, { session: 1 });
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs });

    const sessionLines = entryLines(new MemorySessionMapper('test').map(ctx)[0]!.content);
    const userLines = entryLines(new MemoryUserMapper('test').map(ctx)[0]!.content);
    expect(sessionLines).toHaveLength(1); // session 层 quota=1
    expect(userLines).toHaveLength(1); // global 层默认 50，仅 1 条全要
  });

  it('两 mapper 配额均 0 → 均不贡献 fragment', async () => {
    await writeEntry(globalMemoryDir(dataDir), { name: 'u1', intro: 'i', type: 'user', body: 'b' }, { source: 'user' });
    await writeEntry(wsMemoryDir(sessionWs), { name: 's1', intro: 'i', type: 'user', body: 'b' }, {});

    setMemoryQuotas(appConfig, { global: 0, session: 0 });
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs });

    expect(new MemoryUserMapper('test').map(ctx)).toEqual([]);
    expect(new MemorySessionMapper('test').map(ctx)).toEqual([]);
  });

  it('仅 global 配额 0（session 默认 20）→ user mapper 不贡献 / session mapper 贡献', async () => {
    await writeEntry(globalMemoryDir(dataDir), { name: 'u1', intro: 'i', type: 'user', body: 'b' }, { source: 'user' });
    await writeEntry(wsMemoryDir(sessionWs), { name: 's1', intro: 'i', type: 'user', body: 'b' }, {});

    setMemoryQuotas(appConfig, { global: 0 });
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs });
    expect(new MemoryUserMapper('test').map(ctx)).toEqual([]);
    expect(new MemorySessionMapper('test').map(ctx)[0]!.content).toContain('- s1');
  });

  it('仅 session 配额 0（global 默认 50）→ session mapper 不贡献 / user mapper 贡献', async () => {
    await writeEntry(globalMemoryDir(dataDir), { name: 'u1', intro: 'i', type: 'user', body: 'b' }, { source: 'user' });
    await writeEntry(wsMemoryDir(sessionWs), { name: 's1', intro: 'i', type: 'user', body: 'b' }, {});

    setMemoryQuotas(appConfig, { session: 0 });
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs });
    expect(new MemoryUserMapper('test').map(ctx)[0]!.content).toContain('- u1');
    expect(new MemorySessionMapper('test').map(ctx)).toEqual([]);
  });

  it('maxMemoryInject 缺失 → 默认 50（少量 entries 全入选）', async () => {
    await writeEntry(globalMemoryDir(dataDir), { name: 'u1', intro: 'i', type: 'user', body: 'b' }, { source: 'user' });
    await writeEntry(wsMemoryDir(sessionWs), { name: 's1', intro: 'i', type: 'user', body: 'b' }, {});

    // 不设 session.maxMemoryInject
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs });
    expect(new MemoryUserMapper('test').map(ctx)[0]!.content).toContain('- u1');
    expect(new MemorySessionMapper('test').map(ctx)[0]!.content).toContain('- s1');
  });

  it('maxMemoryInject=1（仅 global 层）：session 默认 20 独立 → 两 mapper 各贡献', async () => {
    await writeEntry(wsMemoryDir(sessionWs), { name: 'sm', intro: 'i', type: 'user', body: 'b' }, {}); // session-agent 组
    await writeEntry(globalMemoryDir(dataDir), { name: 'um', intro: 'i', type: 'user', body: 'b' }, { source: 'user' });

    setMemoryQuotas(appConfig, { global: 1 });
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs });

    // v0.0.238 分层：各 scope 独立——session mapper 出 sm；user mapper 出 um（global=1，仅 1 条）
    expect(new MemorySessionMapper('test').map(ctx)).toHaveLength(1);
    expect(new MemoryUserMapper('test').map(ctx)).toHaveLength(1);
  });

  it('两源均空 → 两 mapper 均不贡献（[]）', () => {
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs });
    expect(new MemoryUserMapper('test').map(ctx)).toEqual([]);
    expect(new MemorySessionMapper('test').map(ctx)).toEqual([]);
  });

  it('global 源空 + session 源有 → user mapper 不贡献 / session mapper 贡献', async () => {
    await writeEntry(wsMemoryDir(sessionWs), { name: 's1', intro: 'i', type: 'user', body: 'b' }, {});
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs });
    expect(new MemoryUserMapper('test').map(ctx)).toEqual([]);
    expect(new MemorySessionMapper('test').map(ctx)[0]!.content).toContain('- s1');
  });

  it('session 源空 + global 源有 → session mapper 不贡献 / user mapper 贡献', async () => {
    await writeEntry(globalMemoryDir(dataDir), { name: 'u1', intro: 'i', type: 'user', body: 'b' }, { source: 'user' });
    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs });
    expect(new MemoryUserMapper('test').map(ctx)[0]!.content).toContain('- u1');
    expect(new MemorySessionMapper('test').map(ctx)).toEqual([]);
  });

  it('fragment id/tier/priority 不变（不破坏既有契约）', async () => {
    await writeEntry(globalMemoryDir(dataDir), { name: 'u1', intro: 'i', type: 'user', body: 'b' }, { source: 'user' });
    await writeEntry(wsMemoryDir(sessionWs), { name: 's1', intro: 'i', type: 'user', body: 'b' }, {});

    const ctx = makeCtx({ appConfig, dataDir, workdir: sessionWs });
    const uf = new MemoryUserMapper('test').map(ctx)[0]!;
    const sf = new MemorySessionMapper('test').map(ctx)[0]!;

    expect(uf.id).toBe('memory_user');
    expect(uf.tier).toBe('stable');
    expect(uf.priority).toBe(450);
    expect(sf.id).toBe('memory_session');
    expect(sf.tier).toBe('context');
    expect(sf.priority).toBe(350);
  });
});
