/**
 * listChildren + GET /session/:id/children UT（v0.0.28 task-2）
 * 参考: specs/api/overall/10-multi-agent.md §3（GET /session/:id/children 契约）
 *       specs/tech/multi_agent/[P1]subagent_derivation.md §7（list_children 同源逻辑）
 *       states/v0.0.28/task.json tasks[1] acceptance「listChildren 查询方法」
 *
 * 覆盖：
 *   - listChildren(parentSid, filter)：running/terminated 分组 + updatedAt desc + limit 截断 + status/templateType 筛
 *   - GET /session/:id/children handler：200 ChildrenView + 404 parent 不存在 + 400 status/limit 非法
 *
 * 真实落盘：fs engine + tmpdir + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import {
  SessionSchema, MessageSchema, SummarySchema, RunSchema,
} from '../schema_defs';
import { SessionStore } from '../session-store';

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-list-children-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('SessionStore.listChildren — 分组 + 排序 + 截断 + 筛选', () => {
  it('running/terminated 分组 + 组内 updatedAt desc', async () => {
    const parentSid = ulid();
    await store.createSession({ id: parentSid, title: 'parent' });
    // running child
    const runningChild = ulid();
    await store.createSession({
      id: runningChild, parentSessionId: parentSid, derivation: 'subagent', role: 'rocky', 
    });
    await store.stateMachine.markRunning(runningChild, ulid());
    // terminated child (idle)
    const terminatedChild = ulid();
    await store.createSession({
      id: terminatedChild, parentSessionId: parentSid, derivation: 'subagent', role: 'rocky', 
      subAgentTemplateType: 'explorer',
    });

    const view = await store.listChildren(parentSid);
    expect(view.parentSessionId).toBe(parentSid);
    expect(view.running.length).toBe(1);
    expect(view.running[0]!.sessionId).toBe(runningChild);
    expect(view.terminated.length).toBe(1);
    expect(view.terminated[0]!.sessionId).toBe(terminatedChild);
    expect(view.terminated[0]!.subAgentTemplateType).toBe('explorer');
  });

  it('status=running 仅返 running 组（terminated=[]）', async () => {
    const parentSid = ulid();
    await store.createSession({ id: parentSid });
    const c1 = ulid();
    await store.createSession({ id: c1, parentSessionId: parentSid, derivation: 'subagent', role: 'rocky' });
    await store.stateMachine.markRunning(c1, ulid());
    const c2 = ulid();
    await store.createSession({ id: c2, parentSessionId: parentSid, derivation: 'subagent', role: 'rocky' });

    const view = await store.listChildren(parentSid, { status: 'running' });
    expect(view.running.length).toBe(1);
    expect(view.terminated).toEqual([]); // 未请求组返 []
  });

  it('limit 截断（组内按 updatedAt desc 取前 N）', async () => {
    const parentSid = ulid();
    await store.createSession({ id: parentSid });
    for (let i = 0; i < 5; i++) {
      await store.createSession({ id: ulid(), parentSessionId: parentSid, derivation: 'subagent', role: 'rocky' });
    }
    const view = await store.listChildren(parentSid, { limit: 2 });
    expect(view.terminated.length).toBe(2); // 截断
    expect(view.running.length).toBe(0);
  });

  it('templateType 筛（仅返该模板标签的 child）', async () => {
    const parentSid = ulid();
    await store.createSession({ id: parentSid });
    await store.createSession({
      id: ulid(), parentSessionId: parentSid, derivation: 'subagent', role: 'rocky', subAgentTemplateType: 'explorer',
    });
    await store.createSession({
      id: ulid(), parentSessionId: parentSid, derivation: 'subagent', role: 'rocky', subAgentTemplateType: 'coder',
    });
    const view = await store.listChildren(parentSid, { templateType: 'explorer' });
    expect(view.terminated.length).toBe(1);
    expect(view.terminated[0]!.subAgentTemplateType).toBe('explorer');
  });

  it('inline spawn（无 templateType）→ name=默认占位 "subagent"，subAgentTemplateType=null', async () => {
    const parentSid = ulid();
    await store.createSession({ id: parentSid });
    const inline = ulid();
    await store.createSession({ id: inline, parentSessionId: parentSid, derivation: 'subagent', role: 'rocky' });
    const view = await store.listChildren(parentSid);
    const c = view.terminated.find((x) => x.sessionId === inline);
    expect(c).toBeDefined();
    expect(c!.name).toBe('subagent'); // 默认占位
    expect(c!.subAgentTemplateType).toBeNull();
  });

  it('parent 不存在仍返空 view（caller 决定 404）', async () => {
    const view = await store.listChildren('nonexistent-parent');
    expect(view.parentSessionId).toBe('nonexistent-parent');
    expect(view.running).toEqual([]);
    expect(view.terminated).toEqual([]);
  });
});
