/**
 * GET /skill?sessionId= 单测（v0.0.205 新增：按 session 派生四层合并 catalog）
 * 参考: specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A6
 *       specs/api/overall/06-skill.md §3（?sessionId= 与 ?workspace= 并存，sessionId 优先）
 *
 * 覆盖：
 *   - sessionId 命中 → workspace=session.workspaceDir + groupDir=resolveGroupWsDir 派生
 *   - squad session → group 层扫 <dataDir>/squads/<sid>/.rocky/skills/（scope='group'）
 *   - playground（无 squad）→ 三层（无 group 层）
 *   - session not found → 404；workspaceDir 缺省回退 <dataDir>/workspace
 *   - sessionId 优先于 ?workspace=
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSkillRoute } from '../skill';
import { AppConfigService } from '../../config/app-config-service';
import type { SessionStore } from '../../agent/session-store';
import type { Session } from '../../agent/session-store-types';

let tmpDataDir: string;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'skill-list-sess-'));
});
afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
});

/** 测试内 session 注册表 */
let sessions: Map<string, Partial<Session>>;
beforeEach(() => {
  sessions = new Map();
});

function fakeSessionStore(): SessionStore {
  return {
    getSession: async (id: string) => (sessions.get(id) as Session) ?? null,
  } as unknown as SessionStore;
}

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf8');
}

async function list(query: Record<string, string>): Promise<{ status: number; body: any }> {
  const url = new URL('http://test/skill');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const req = new Request(url, { method: 'GET' });
  const res = await handleSkillRoute(
    req, 'GET', '/skill', url,
    new AppConfigService({ root: tmpDataDir }),
    tmpDataDir,
    fakeSessionStore(),
  );
  return { status: res.status, body: await res.json() };
}

describe('GET /skill?sessionId=', () => {
  it('squad session → 四层合并，squad 层 scope=group（覆盖 workspace 同名）', async () => {
    const ws = join(tmpDataDir, 'member-ws');
    sessions.set('sess-1', { id: 'sess-1', workspaceDir: ws, squadId: 'sq-1' } as Partial<Session>);
    writeSkill(join(ws, '.rocky', 'skills', 'shared'), 'shared', 'workspace 版');
    writeSkill(join(tmpDataDir, 'squads', 'sq-1', '.rocky', 'skills', 'shared'), 'shared', 'group 版');
    writeSkill(join(tmpDataDir, 'squads', 'sq-1', '.rocky', 'skills', 'team-only'), 'team-only', '团队专属');

    const { status, body } = await list({ sessionId: 'sess-1' });
    expect(status).toBe(200);
    const byName = new Map<string, any>(body.items.map((e: any) => [e.name, e]));
    expect(byName.get('shared')?.scope).toBe('group'); // group 覆盖 workspace
    expect(byName.get('shared')?.description).toBe('group 版');
    expect(byName.get('team-only')?.scope).toBe('group');
  });

  it('playground session（无 squad）→ 三层（无 group 层）', async () => {
    const ws = join(tmpDataDir, 'pg-ws');
    sessions.set('sess-3', { id: 'sess-3', workspaceDir: ws } as Partial<Session>);
    writeSkill(join(ws, '.rocky', 'skills', 'ws-skill'), 'ws-skill', 'ws 版');
    // 某 squad 有 skill，但 playground session 不应扫到
    writeSkill(join(tmpDataDir, 'squads', 'sq-x', '.rocky', 'skills', 'alien'), 'alien', 'x');

    const { status, body } = await list({ sessionId: 'sess-3' });
    expect(status).toBe(200);
    const names = body.items.map((e: any) => e.name);
    expect(names).toContain('ws-skill');
    expect(names).not.toContain('alien');
  });

  it('session not found → 404', async () => {
    const { status, body } = await list({ sessionId: 'ghost' });
    expect(status).toBe(404);
    expect(body.error).toMatch(/session not found/);
  });

  it('workspaceDir 缺省（空串）→ 回退 <dataDir>/workspace', async () => {
    sessions.set('sess-4', { id: 'sess-4', workspaceDir: '' } as Partial<Session>);
    writeSkill(join(tmpDataDir, 'workspace', '.rocky', 'skills', 'fb-skill'), 'fb-skill', 'fallback 版');

    const { status, body } = await list({ sessionId: 'sess-4' });
    expect(status).toBe(200);
    expect(body.items.map((e: any) => e.name)).toContain('fb-skill');
  });

  it('sessionId 优先于 ?workspace=（两者同传时按 session 派生）', async () => {
    const ws = join(tmpDataDir, 'sess-ws');
    const otherWs = join(tmpDataDir, 'other-ws');
    sessions.set('sess-5', { id: 'sess-5', workspaceDir: ws } as Partial<Session>);
    writeSkill(join(ws, '.rocky', 'skills', 'sess-skill'), 'sess-skill', 'session 版');
    writeSkill(join(otherWs, '.rocky', 'skills', 'other-skill'), 'other-skill', 'other 版');

    const { status, body } = await list({ sessionId: 'sess-5', workspace: otherWs });
    expect(status).toBe(200);
    const names = body.items.map((e: any) => e.name);
    expect(names).toContain('sess-skill');
    expect(names).not.toContain('other-skill');
  });

  it('不带 sessionId → 既有 ?workspace= 行为不变（三层）', async () => {
    const ws = join(tmpDataDir, 'plain-ws');
    writeSkill(join(ws, '.rocky', 'skills', 'plain-skill'), 'plain-skill', 'plain 版');
    const { status, body } = await list({ workspace: ws });
    expect(status).toBe(200);
    expect(body.items.map((e: any) => e.name)).toContain('plain-skill');
  });
});
