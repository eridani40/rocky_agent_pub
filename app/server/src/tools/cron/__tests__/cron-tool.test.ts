/**
 * cron agent 工具单测（单工具 + 6 action）— action=create/list/update/disable/enable/delete + isError 路径。
 * 参考: specs/api/overall/16-cron.md §3（inputSchema + 出参 + 错误共通契约）
 *       specs/tech/scheduling/[P1]cron_subsystem.md §6（6 操作表 + sessionId 自动取 ctx.session.id）
 *
 * 覆盖（单工具 cron，6 action 变体）：
 *   create 成功 / cron expr 非法 / prompt 空 / cron 缺失 / name 缺省 / tz 自动取
 *   list 列出全部 / 空 session / disabled job nextFireAt=null
 *   update 字段改 / job 不存在 / jobId 缺失 / cron 非法
 *   disable → enabled:false / enable → enabled:true 不重置 lastFiredAt / job 不存在
 *   delete 永久删 / 不存在 / jobId 缺失
 *   action 缺失 / action 非法（前置校验）
 *   sessionId 自动取 ctx.config.sessionId / cronToolDeps 缺失 / sessionId 缺失 / deps 形状不全
 *   definition.name='cron' + inputSchema.required=['action'] 对齐 spec §3
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '../../../config/ulid';
import { cronTool } from '../cron-tool';
import type { CronToolDeps } from '../cron-tool-shared';
import { CronPersistenceAdapter } from '../../../scheduling/persistence/cron-adapter';
import { SchedulerEngine } from '../../../scheduling/engine';
import { JobHandlerRegistry } from '../../../scheduling/registry';
import { SessionStore } from '../../../agent/session-store';
import { SessionSchema } from '../../../agent/schema_defs';
import { SquadStore } from '../../../stores/squad-store';
import { CompositeStore } from '../../../persistence/composite';
import { FsCrudStore } from '../../../persistence/fs-store';
import type { ToolCtx, ToolRunResult } from '../../types';

let tmpRoot: string;
let engine: SchedulerEngine;
let cronStore: CronPersistenceAdapter;
let sessionStore: SessionStore;
let squadStore: SquadStore;
let deps: CronToolDeps;
let sessionId: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cron-tool-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine)
    .mount('transcript', fsEngine)
    .mount('summary', fsEngine)
    .mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  squadStore = new SquadStore({ root: tmpRoot });
  engine = new SchedulerEngine({ registry: new JobHandlerRegistry() });
  cronStore = new CronPersistenceAdapter({
    fsRoot: tmpRoot,
    resolveSquadId: async () => null,
  });
  deps = { cronStore, engine, sessionStore, squadStore };
  sessionId = ulid();
  await sessionStore.createSession({ id: sessionId, title: 't' });
});

afterEach(() => {
  engine.stop();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────

const CRON = '0 9 * * *'; // 每天 9 点

/** 构造 ToolCtx（cronToolDeps + sessionId 注入；与生产 ctx.config 形态一致） */
function ctxOf(overrides: { cronToolDeps?: unknown; sessionId?: string; omitDeps?: boolean } = {}): ToolCtx {
  const cfg: Record<string, unknown> = {
    tools: [],
    sessionId: overrides.sessionId ?? sessionId,
  };
  // omitDeps=true 时不注入 cronToolDeps（测 isError 路径用）
  if (!overrides.omitDeps) cfg.cronToolDeps = overrides.cronToolDeps ?? deps;
  // 强制 as ToolCtx（cfg.tools=never[] 可兼容 Tool[]；鸭子类型，运行时不需要真 Tool 实例）
  return { config: cfg as unknown as ToolCtx['config'], workdir: tmpRoot };
}

/** 解 ToolRunResult 出参 JSON（content[0].text → JSON.parse） */
function parseResult(r: ToolRunResult): any {
  expect(r.content).toHaveLength(1);
  expect(r.content[0]!.type).toBe('text');
  return JSON.parse((r.content[0] as { type: 'text'; text: string }).text);
}

/** 取 isError 结果的 text */
function textOf(r: ToolRunResult): string {
  expect(r.content[0]!.type).toBe('text');
  return (r.content[0] as { type: 'text'; text: string }).text;
}

/** 通过 cron(action=create) 建一个 job，返 jobId（用于 update/disable/enable/delete 测试） */
async function createJob(opts: Partial<{ cron: string; prompt: string; name: string }> = {}): Promise<string> {
  const r = await cronTool.run(
    {
      action: 'create',
      cron: opts.cron ?? CRON,
      prompt: opts.prompt ?? '检查 todo.md',
      ...(opts.name ? { name: opts.name } : {}),
    },
    ctxOf(),
  );
  expect(r.isError).toBe(false);
  return parseResult(r).jobId as string;
}

// ============================================================
// action=create
// ============================================================

describe('cron action=create', () => {
  it('成功 → {jobId, cron, name, nextFireAt}', async () => {
    const r = await cronTool.run({ action: 'create', cron: CRON, prompt: 'check todos' }, ctxOf());
    expect(r.isError).toBe(false);
    const out = parseResult(r);
    expect(out.jobId).toMatch(new RegExp(`^cron:${sessionId}:`));
    expect(out.cron).toBe(CRON);
    expect(out.name).toBe('check todos');
    expect(out.nextFireAt).toBeTruthy();
  });

  it('cron expr 非法 → isError + [cron:create] cron expr invalid', async () => {
    const r = await cronTool.run({ action: 'create', cron: 'invalid', prompt: 'x' }, ctxOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/\[cron:create\] cron expr invalid/);
  });

  it('prompt 空 → isError + [cron:create] prompt required', async () => {
    const r = await cronTool.run({ action: 'create', cron: CRON, prompt: '   ' }, ctxOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/\[cron:create\] prompt required/);
  });

  it('cron 缺失 → isError + [cron:create] cron required', async () => {
    const r = await cronTool.run({ action: 'create', prompt: 'x' }, ctxOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/\[cron:create\] cron required/);
  });

  it('name 缺省 = prompt.slice(0,30)', async () => {
    const long = 'a'.repeat(50);
    const r = await cronTool.run({ action: 'create', cron: CRON, prompt: long }, ctxOf());
    expect(r.isError).toBe(false);
    // 用 action=list 验 name
    const list = await cronTool.run({ action: 'list' }, ctxOf());
    const out = parseResult(list);
    expect(out.jobs[0].name).toBe('a'.repeat(30));
  });

  it('tz 自动取 session.timezone', async () => {
    const cur = (sessionStore as any).crud.get(SessionSchema, sessionId);
    const { createdAt: _ca, updatedAt: _ua, version: _v, ...rest } = cur;
    void _ca; void _ua; void _v;
    (sessionStore as any).crud.put(SessionSchema, { ...rest, timezone: 'Asia/Tokyo' });
    await cronTool.run({ action: 'create', cron: CRON, prompt: 'x' }, ctxOf());
    const list = await cronTool.run({ action: 'list' }, ctxOf());
    const out = parseResult(list);
    expect(out.jobs[0].tz).toBe('Asia/Tokyo');
  });
});

// ============================================================
// action=list
// ============================================================

describe('cron action=list', () => {
  it('列出当前 session 全部 jobs', async () => {
    await createJob({ prompt: 'job1' });
    await createJob({ prompt: 'job2' });
    const r = await cronTool.run({ action: 'list' }, ctxOf());
    expect(r.isError).toBe(false);
    const out = parseResult(r);
    expect(out.jobs).toHaveLength(2);
    expect(out.jobs[0].id).toMatch(new RegExp(`^cron:${sessionId}:`));
    expect(out.jobs[0].nextFireAt).toBeTruthy();
  });

  it('空 session → {jobs:[]}', async () => {
    const r = await cronTool.run({ action: 'list' }, ctxOf());
    expect(r.isError).toBe(false);
    expect(parseResult(r)).toEqual({ jobs: [] });
  });

  it('disabled job → nextFireAt=null', async () => {
    const r1 = await cronTool.run({ action: 'create', cron: CRON, prompt: 'x', enabled: false }, ctxOf());
    expect(r1.isError).toBe(false);
    const list = await cronTool.run({ action: 'list' }, ctxOf());
    const out = parseResult(list);
    expect(out.jobs[0].enabled).toBe(false);
    expect(out.jobs[0].nextFireAt).toBeNull();
  });
});

// ============================================================
// action=update
// ============================================================

describe('cron action=update', () => {
  it('字段改 → {jobId, cron, name, prompt}', async () => {
    const jid = await createJob();
    const r = await cronTool.run(
      { action: 'update', jobId: jid, cron: '*/5 * * * *', prompt: 'new', name: 'renamed' },
      ctxOf(),
    );
    expect(r.isError).toBe(false);
    const out = parseResult(r);
    expect(out).toEqual({ jobId: jid, cron: '*/5 * * * *', name: 'renamed', prompt: 'new' });
  });

  it('job 不存在 → isError + [cron:update] job not found', async () => {
    const r = await cronTool.run({ action: 'update', jobId: 'cron:nope:1', prompt: 'x' }, ctxOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/\[cron:update\] job not found/);
  });

  it('jobId 缺失 → isError + [cron:update] jobId required', async () => {
    const r = await cronTool.run({ action: 'update', prompt: 'x' }, ctxOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/\[cron:update\] jobId required/);
  });

  it('cron 非法 → isError + [cron:update] cron expr invalid', async () => {
    const jid = await createJob();
    const r = await cronTool.run({ action: 'update', jobId: jid, cron: '99 99 99 99 99' }, ctxOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/\[cron:update\] cron expr invalid/);
  });
});

// ============================================================
// action=disable / action=enable
// ============================================================

describe('cron action=disable / action=enable', () => {
  it('disable → {jobId, enabled:false} + list nextFireAt=null', async () => {
    const jid = await createJob();
    const r = await cronTool.run({ action: 'disable', jobId: jid }, ctxOf());
    expect(r.isError).toBe(false);
    expect(parseResult(r)).toEqual({ jobId: jid, enabled: false });
    const list = await cronTool.run({ action: 'list' }, ctxOf());
    const out = parseResult(list);
    expect(out.jobs[0].enabled).toBe(false);
    expect(out.jobs[0].nextFireAt).toBeNull();
  });

  it('enable → {jobId, enabled:true} + 不重置 lastFiredAt', async () => {
    const jid = await createJob();
    await cronTool.run({ action: 'disable', jobId: jid }, ctxOf());
    // 模拟 lastFiredAt 已有值
    const job = (await cronStore.loadJobs(sessionId)).find((j) => j.id === jid)!;
    const fired = '2025-01-01T00:00:00.000Z';
    await cronStore.upsertJob(sessionId, { ...job, lastFiredAt: fired, enabled: false });
    const r = await cronTool.run({ action: 'enable', jobId: jid }, ctxOf());
    expect(r.isError).toBe(false);
    expect(parseResult(r)).toEqual({ jobId: jid, enabled: true });
    const after = (await cronStore.loadJobs(sessionId)).find((j) => j.id === jid)!;
    expect(after.lastFiredAt).toBe(fired); // 续接保留
  });

  it('disable job 不存在 → isError + [cron:disable] job not found', async () => {
    const r = await cronTool.run({ action: 'disable', jobId: 'cron:nope:1' }, ctxOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/\[cron:disable\] job not found/);
  });

  it('enable job 不存在 → isError + [cron:enable] job not found', async () => {
    const r = await cronTool.run({ action: 'enable', jobId: 'cron:nope:1' }, ctxOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/\[cron:enable\] job not found/);
  });
});

// ============================================================
// action=delete
// ============================================================

describe('cron action=delete', () => {
  it('永久删 → {jobId, deleted:true} + list 不再返', async () => {
    const jid = await createJob();
    const r = await cronTool.run({ action: 'delete', jobId: jid }, ctxOf());
    expect(r.isError).toBe(false);
    expect(parseResult(r)).toEqual({ jobId: jid, deleted: true });
    const list = await cronTool.run({ action: 'list' }, ctxOf());
    expect(parseResult(list)).toEqual({ jobs: [] });
  });

  it('delete 不存在 → isError + [cron:delete] job not found', async () => {
    const r = await cronTool.run({ action: 'delete', jobId: 'cron:nope:1' }, ctxOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/\[cron:delete\] job not found/);
  });

  it('jobId 缺失 → isError + [cron:delete] jobId required', async () => {
    const r = await cronTool.run({ action: 'delete' }, ctxOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/\[cron:delete\] jobId required/);
  });
});

// ============================================================
// action 前置校验（缺失 / 非法）
// ============================================================

describe('cron action 前置校验', () => {
  it('action 缺失 → isError + cron: action 必填', async () => {
    const r = await cronTool.run({ cron: CRON, prompt: 'x' }, ctxOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/cron: action 必填/);
  });

  it('action 非法 → isError + cron: action 非法', async () => {
    const r = await cronTool.run({ action: 'foo', cron: CRON, prompt: 'x' }, ctxOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/cron: action 非法 \(foo\)/);
  });

  it('action 非字符串 → isError + action 必填', async () => {
    const r = await cronTool.run({ action: 123 }, ctxOf());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/cron: action 必填/);
  });
});

// ============================================================
// 边界 / 异常
// ============================================================

describe('cron 工具 — 边界 / 异常', () => {
  it('sessionId 自动取 ctx.config.sessionId（不传 input.sessionId）', async () => {
    // 创建 job 不带任何 sessionId 入参（agent 不应传）
    const r = await cronTool.run({ action: 'create', cron: CRON, prompt: 'x' }, ctxOf());
    expect(r.isError).toBe(false);
    // 验证 job 落在 ctx.config.sessionId 对应的 session 下
    const list = await cronTool.run({ action: 'list' }, ctxOf());
    const out = parseResult(list);
    expect(out.jobs[0].sessionId).toBe(sessionId);
  });

  it('ctx.config.cronToolDeps 缺失 → isError + [cron:create] cronToolDeps not injected', async () => {
    const ctx = ctxOf({ omitDeps: true });
    const r = await cronTool.run({ action: 'create', cron: CRON, prompt: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/\[cron:create\] runtime error: cronToolDeps not injected/);
  });

  it('ctx.config.sessionId 缺失 → isError + [cron:list] sessionId missing', async () => {
    const ctx = ctxOf({ sessionId: '' });
    const r = await cronTool.run({ action: 'list' }, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/\[cron:list\] runtime error: sessionId missing/);
  });

  it('cronToolDeps 形状不全（缺 squadStore） → isError', async () => {
    const ctx = ctxOf({ cronToolDeps: { cronStore: {}, engine: {}, sessionStore: {} } });
    const r = await cronTool.run({ action: 'list' }, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/cronToolDeps not injected/);
  });

  it('definition.name=cron + inputSchema.required=[action] 对齐 spec §3', () => {
    expect(cronTool.definition.name).toBe('cron');
    const required = cronTool.definition.inputSchema?.required as string[] | undefined;
    expect(required).toEqual(['action']);
    // action enum 6 值
    const actionProp = cronTool.definition.inputSchema?.properties?.action as {
      type: string; enum: string[];
    };
    expect(actionProp.type).toBe('string');
    expect(actionProp.enum).toEqual([
      'create', 'list', 'update', 'disable', 'enable', 'delete',
    ]);
  });
});
