/**
 * memory_manage 工具单测（v0.0.205：scope 统一 global/session/group + dir store + 默认 global）
 * 参考: specs/tech/agent/memory/[P0]memory_manage_tool.md §2 + §5/§5.1/§5.2
 *       specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4
 *
 * 核心语义（沿用）：
 *   - write/archive agent 路径 enforceEvolvable=true：更新既有 evolvable=false / archive → invalid_input 拒绝
 *   - write body >500 字符 → invalid_input 拒绝（store 层单点，不落盘）
 *   - write intro >50 字符 → invalid_input 拒绝（store 层单点，不落盘）
 *   - read 走 query.readMemoryEntry（不变量#4）；scope 直通回显（无 internal/external 映射层）
 *   - 介质定位：global→<dataDir>/memory/、session→<ctx.config.workdir>/.rocky/memory/
 *   - BUG-001：gate 先于 type（省略 type 时继承既有 type 抵达 gate）
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + process.env.DATA_DIR 覆盖 + afterEach rmSync。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryManageTool } from '../memory-manage';
import { textOf } from './_helpers';
import {
  globalMemoryDir,
  listEntries,
  readEntry,
  wsMemoryDir,
} from '../../memory/memory-dir-store';
import { writeEntry } from '../../memory/memory-dir-write';

let tmpDataDir: string;
let origDataDir: string | undefined;
let sessionWs: string;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'mem-tool-test-'));
  origDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDataDir;
  sessionWs = join(tmpDataDir, 'sess-ws');
});

afterEach(() => {
  if (origDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = origDataDir;
  rmSync(tmpDataDir, { recursive: true, force: true });
});

/**
 * 构造 ToolCtx（workdir 入 ctx.config = session 介质定位；squadId 供 group 解析；biz 供 scope 校验）
 * v0.0.238：scope 写侧必填 + 按 biz 校验——playground 默认（无 kind），group 写需 kind.biz='studio'|'academy'
 */
function ctxOf(opts: { workdir?: string; squadId?: string; biz?: string } = {}): {
  config: Record<string, unknown>;
  workdir: string;
} {
  const config: Record<string, unknown> = { tools: [] };
  if (opts.workdir !== undefined) config.workdir = opts.workdir;
  if (opts.squadId !== undefined) config.squadId = opts.squadId;
  // biz 默认 playground（无 kind）；测试可显式传 'studio'/'academy' 启用 group
  config.kind = { biz: opts.biz ?? 'playground' };
  return { config, workdir: tmpDataDir };
}

const globalDir = () => globalMemoryDir(tmpDataDir);
const sessionDir = () => wsMemoryDir(sessionWs);
const sessionCtx = () => ctxOf({ workdir: sessionWs });

describe('memory_manage 工具 — scope=global 分流（<dataDir>/memory/）', () => {
  it('write action 成功（落 per-entry 文件，scope 回显 global）', async () => {
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'global', entry: { name: 'u1', intro: 'd', type: 'user', body: 'vim is best' } },
      ctxOf() as never,
    );
    expect(res.isError).toBe(false);
    const payload = JSON.parse(textOf(res));
    expect(payload).toMatchObject({ ok: true, action: 'write', scope: 'global' });
    expect(payload.entry.name).toBe('u1');
    expect(payload.entry.evolvable).toBe(true); // agent 新建 evolvable=true
    expect(listEntries(globalDir()).map((e) => e.name)).toEqual(['u1']);
  });

  it('list action 返 global entries metadata（含 evolvable，不含 body）', async () => {
    await writeEntry(globalDir(), { name: 'list-me', intro: 'd', type: 'user', body: 'b' }, { defaultEvolvable: true });
    const res = await memoryManageTool.run({ action: 'list', scope: 'global' }, ctxOf() as never);
    const payload = JSON.parse(textOf(res));
    expect(payload.scope).toBe('global');
    expect(payload.count).toBe(1);
    expect(payload.entries[0].name).toBe('list-me');
    expect(payload.entries[0].scope).toBe('global');
    expect(payload.entries[0].evolvable).toBe(true);
    expect(payload.entries[0].body).toBeUndefined();
  });

  it('read action 返全文（走 query.readMemoryEntry，scope 回显 global）', async () => {
    await writeEntry(globalDir(), { name: 'r1', intro: 'd', type: 'feedback', body: 'body-text', why: 'w', howToApply: 'h' }, {});
    const res = await memoryManageTool.run({ action: 'read', scope: 'global', name: 'r1' }, ctxOf() as never);
    const payload = JSON.parse(textOf(res));
    expect(payload.scope).toBe('global');
    expect(payload.entry).toMatchObject({ name: 'r1', body: 'body-text', why: 'w', howToApply: 'h', scope: 'global' });
  });

  it('archive action 标 archived=true（scope 回显 global）', async () => {
    await writeEntry(globalDir(), { name: 'a1', intro: 'd', type: 'user', body: 'b' }, { defaultEvolvable: true });
    const res = await memoryManageTool.run({ action: 'archive', scope: 'global', name: 'a1' }, ctxOf() as never);
    const payload = JSON.parse(textOf(res));
    expect(payload.scope).toBe('global');
    expect(payload.entry.archived).toBe(true);
  });

  it('read 未找到 → isError (NOT_FOUND)', async () => {
    const res = await memoryManageTool.run({ action: 'read', scope: 'global', name: 'ghost' }, ctxOf() as never);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not_found|not found/i);
  });
});

describe('memory_manage 工具 — scope 写侧必填（v0.0.238：不传 scope → invalid_input）', () => {
  it('write 不传 scope → invalid_input + biz 引导（不再默认 global）', async () => {
    const res = await memoryManageTool.run(
      { action: 'write', entry: { name: 'noscope', intro: 'd', type: 'user', body: 'no scope' } },
      ctxOf() as never,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/invalid_input/i);
    expect(textOf(res)).toMatch(/scope is required/i);
    // 不落盘
    expect(listEntries(globalDir()).map((e) => e.name)).toEqual([]);
  });

  it('read 不传 scope → 仍默认 global（读侧宽容，不收窄）', async () => {
    await writeEntry(globalDir(), { name: 'dr', intro: 'd', type: 'user', body: 'x' }, {});
    const res = await memoryManageTool.run({ action: 'read', name: 'dr' }, ctxOf() as never);
    const payload = JSON.parse(textOf(res));
    expect(payload.scope).toBe('global');
    expect(payload.entry.name).toBe('dr');
  });

  it('playground 传 group → invalid_input + scopeUnavailable 引导', async () => {
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'group', entry: { name: 'nope', intro: 'd', type: 'user', body: 'b' } },
      ctxOf() as never, // biz=playground，group 不可用
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/invalid_input/i);
    expect(textOf(res)).toMatch(/not available for playground/i);
  });

  it('studio 传 session → invalid_input（studio 无 session 层）', async () => {
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'session', entry: { name: 'nope', intro: 'd', type: 'user', body: 'b' } },
      ctxOf({ biz: 'studio', workdir: sessionWs }) as never,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not available for studio/i);
  });
});

describe('memory_manage 工具 — evolvable gate（agent 进化性写）', () => {
  it('更新既有 evolvable=false 条目 → invalid_input 拒绝', async () => {
    await writeEntry(globalDir(), { name: 'locked', intro: 'd', type: 'user', body: 'original' }, { setEvolvable: false });
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'global', entry: { name: 'locked', intro: 'd2', type: 'user', body: 'changed' } },
      ctxOf() as never,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/invalid_input/);
    expect(textOf(res)).toMatch(/non-evolvable/i);
  });

  it('archive evolvable=false 条目 → invalid_input 拒绝', async () => {
    await writeEntry(globalDir(), { name: 'locked2', intro: 'd', type: 'user', body: 'b' }, { setEvolvable: false });
    const res = await memoryManageTool.run({ action: 'archive', scope: 'global', name: 'locked2' }, ctxOf() as never);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/non-evolvable/i);
  });

  it('新建（name 不存在）不 gate → 允许，自动 evolvable=true', async () => {
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'global', entry: { name: 'fresh', intro: 'd', type: 'user', body: 'b' } },
      ctxOf() as never,
    );
    expect(JSON.parse(textOf(res)).entry.evolvable).toBe(true);
  });

  it('BUG-001 global：更新既有 evolvable=false、省略 type → non-evolvable 而非 type 错误', async () => {
    await writeEntry(globalDir(), { name: 'locked-notype', intro: 'd', type: 'user', body: 'orig' }, { setEvolvable: false });
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'global', entry: { name: 'locked-notype', intro: 'd2', body: 'changed' } },
      ctxOf() as never,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/non-evolvable/i);
    expect(textOf(res)).not.toMatch(/entry\.type invalid/i);
    expect(readEntry(globalDir(), 'locked-notype').body).toBe('orig'); // 拒绝后正文未变
  });

  it('BUG-001 创建（无既有）省略 type → 仍报 entry.type 错误（type 必填不受影响）', async () => {
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'global', entry: { name: 'brand-new', intro: 'd', body: 'b' } },
      ctxOf() as never,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/entry\.type invalid/i);
    expect(listEntries(globalDir())).toEqual([]);
  });

  it('BUG-001 更新既有 evolvable=true、省略 type → 继承既有 type 成功', async () => {
    await writeEntry(globalDir(), { name: 'evolve-me', intro: 'd', type: 'feedback', body: 'orig' }, { defaultEvolvable: true });
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'global', entry: { name: 'evolve-me', intro: 'd2', body: 'updated' } },
      ctxOf() as never,
    );
    const payload = JSON.parse(textOf(res));
    expect(payload.entry.type).toBe('feedback');
    expect(payload.entry.body).toBe('updated');
    expect(payload.entry.evolvable).toBe(true);
  });

  it('BUG-001 session：更新既有 evolvable=false、省略 type → non-evolvable（两 scope 一致）', async () => {
    await writeEntry(sessionDir(), { name: 's-locked', intro: 'd', type: 'user', body: 'orig' }, { setEvolvable: false });
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'session', entry: { name: 's-locked', intro: 'd2', body: 'changed' } },
      sessionCtx() as never,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/non-evolvable/i);
    expect(textOf(res)).not.toMatch(/entry\.type invalid/i);
  });
});

describe('memory_manage 工具 — 字符硬限', () => {
  it('write body >500 字符 → invalid_input 拒绝（不落盘）', async () => {
    const body = 'x'.repeat(501); // 501 字符超 500 硬限
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'global', entry: { name: 'toolong', intro: 'd', type: 'user', body } },
      ctxOf() as never,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/exceeds 500 chars/);
    expect(listEntries(globalDir())).toEqual([]);
  });

  it('write body = 500 字符（边界）→ 通过', async () => {
    const body = 'x'.repeat(500); // 正好 500 字符边界
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'global', entry: { name: 'ok500', intro: 'd', type: 'user', body } },
      ctxOf() as never,
    );
    expect(res.isError).toBe(false);
    expect(listEntries(globalDir()).map((e) => e.name)).toEqual(['ok500']);
  });

  it('write intro >50 字符 → invalid_input 拒绝（不落盘）', async () => {
    const intro = 'y'.repeat(51); // 51 字符超 50 硬限
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'global', entry: { name: 'badintro', intro, type: 'user', body: 'ok' } },
      ctxOf() as never,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/exceeds 50 chars/);
    expect(listEntries(globalDir())).toEqual([]);
  });
});

describe('memory_manage 工具 — scope=session 分流（<workdir>/.rocky/memory/）', () => {
  it('write action 成功（落 session ws per-entry，scope 回显 session）', async () => {
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'session', entry: { name: 's1', intro: 'd', type: 'user', body: 'session note' } },
      sessionCtx() as never,
    );
    const payload = JSON.parse(textOf(res));
    expect(payload).toMatchObject({ ok: true, action: 'write', scope: 'session' });
    expect(listEntries(sessionDir()).map((e) => e.name)).toEqual(['s1']);
  });

  it('write scope=session 缺 ctx.config.workdir → RUNTIME_ERROR', async () => {
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'session', entry: { name: 's1', intro: 'd', type: 'user', body: 'b' } },
      ctxOf() as never, // 不注 workdir
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/runtime_error/i);
    expect(textOf(res)).toMatch(/workdir/i);
  });

  it('list scope=session 返 metadata', async () => {
    await memoryManageTool.run(
      { action: 'write', scope: 'session', entry: { name: 's-list', intro: 'd', type: 'project', body: 'b' } },
      sessionCtx() as never,
    );
    const res = await memoryManageTool.run({ action: 'list', scope: 'session' }, sessionCtx() as never);
    const payload = JSON.parse(textOf(res));
    expect(payload.scope).toBe('session');
    expect(payload.count).toBe(1);
    expect(payload.entries[0]).toMatchObject({ name: 's-list', scope: 'session' });
  });

  it('archive scope=session', async () => {
    await memoryManageTool.run(
      { action: 'write', scope: 'session', entry: { name: 's-arch', intro: 'd', type: 'user', body: 'b' } },
      sessionCtx() as never,
    );
    const res = await memoryManageTool.run({ action: 'archive', scope: 'session', name: 's-arch' }, sessionCtx() as never);
    expect(JSON.parse(textOf(res)).entry.archived).toBe(true);
  });

  it('read scope=session 返全文（走 query，scope 回显 session）', async () => {
    await memoryManageTool.run(
      { action: 'write', scope: 'session', entry: { name: 's-read', intro: 'd', type: 'feedback', body: 'text', why: 'w', howToApply: 'h' } },
      sessionCtx() as never,
    );
    const res = await memoryManageTool.run({ action: 'read', scope: 'session', name: 's-read' }, sessionCtx() as never);
    const payload = JSON.parse(textOf(res));
    expect(payload.scope).toBe('session');
    expect(payload.entry).toMatchObject({ name: 's-read', body: 'text', why: 'w', howToApply: 'h', scope: 'session' });
  });
});

describe('memory_manage 工具 — list scope=all（合并 global + session + group）', () => {
  it('all scope 合并条目 + scope 直通回显；无 group 依赖静默跳过 group 段', async () => {
    await memoryManageTool.run(
      { action: 'write', scope: 'global', entry: { name: 'g-one', intro: 'd', type: 'user', body: 'b' } },
      sessionCtx() as never,
    );
    await memoryManageTool.run(
      { action: 'write', scope: 'session', entry: { name: 's-one', intro: 'd', type: 'user', body: 'b' } },
      sessionCtx() as never,
    );
    const res = await memoryManageTool.run({ action: 'list', scope: 'all' }, sessionCtx() as never);
    const payload = JSON.parse(textOf(res));
    expect(payload.scope).toBe('all');
    expect(payload.count).toBe(2);
    const byName = Object.fromEntries(payload.entries.map((e: { name: string }) => [e.name, e]));
    expect(byName['g-one'].scope).toBe('global');
    expect(byName['s-one'].scope).toBe('session');
  });

  it('all scope 含 group 段（有 squadId 时）', async () => {
    await memoryManageTool.run(
      { action: 'write', scope: 'group', entry: { name: 'q-one', intro: 'd', type: 'user', body: 'b' } },
      ctxOf({ squadId: 'sq-1', biz: 'studio' }) as never, // v0.0.238：group 需 biz=studio|academy
    );
    const res = await memoryManageTool.run(
      { action: 'list', scope: 'all' },
      ctxOf({ workdir: sessionWs, squadId: 'sq-1', biz: 'studio' }) as never,
    );
    const payload = JSON.parse(textOf(res));
    const byName = Object.fromEntries(payload.entries.map((e: { name: string }) => [e.name, e]));
    expect(byName['q-one'].scope).toBe('group');
  });
});

describe('memory_manage 工具 — 通用校验', () => {
  it('非法 action → isError', async () => {
    const res = await memoryManageTool.run({ action: 'frob' }, ctxOf() as never);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/action must be one of/i);
  });

  it('write 非法 scope 值（旧 squad/user）→ isError', async () => {
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'squad', entry: { name: 'x', intro: 'd', type: 'user', body: 'b' } },
      ctxOf() as never,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/scope must be global\|session\|group/i);
  });

  it('write 缺 entry → isError (INVALID_INPUT)', async () => {
    const res = await memoryManageTool.run({ action: 'write', scope: 'global' }, ctxOf() as never);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/entry/i);
  });

  it('write 非法 type → isError', async () => {
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'global', entry: { name: 'x', intro: 'd', type: 'bogus', body: 'b' } },
      ctxOf() as never,
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/type/i);
  });

  it('list 非法 scope 值 → isError', async () => {
    const res = await memoryManageTool.run({ action: 'list', scope: 'user' }, ctxOf() as never);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/list scope must be global\|session\|group\|all/i);
  });
});

describe('memory_manage 工具 — intro 字段', () => {
  it('inputSchema entry 属性用 intro（不再是 description）', () => {
    const props = (memoryManageTool.definition.inputSchema as {
      properties: { entry: { properties: Record<string, unknown> } };
    }).properties.entry.properties;
    expect(props.intro).toBeDefined();
    expect(props.description).toBeUndefined();
  });

  it('write 用 intro 落盘；list/read 输出 intro', async () => {
    await memoryManageTool.run(
      { action: 'write', scope: 'global', entry: { name: 'i1', intro: '一句话摘要', type: 'user', body: 'b' } },
      ctxOf() as never,
    );
    const listRes = await memoryManageTool.run({ action: 'list', scope: 'global' }, ctxOf() as never);
    expect(JSON.parse(textOf(listRes)).entries[0].intro).toBe('一句话摘要');
    const readRes = await memoryManageTool.run({ action: 'read', scope: 'global', name: 'i1' }, ctxOf() as never);
    expect(JSON.parse(textOf(readRes)).entry.intro).toBe('一句话摘要');
  });

  it('兼容读：entry 用旧 description 键 → 落盘为 intro（真 LLM 旧提示词兜底）', async () => {
    const res = await memoryManageTool.run(
      { action: 'write', scope: 'global', entry: { name: 'compat', description: '旧字段值', type: 'user', body: 'b' } },
      ctxOf() as never,
    );
    expect(res.isError).toBe(false);
    expect(JSON.parse(textOf(res)).entry.intro).toBe('旧字段值');
    expect(readEntry(globalDir(), 'compat').intro).toBe('旧字段值');
  });
});
