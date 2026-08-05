/**
 * member-academy-bridge + member-preview-handler UT — v0.0.233 derive_academy 预检 + 裁决 + 补偿不变量
 * 参考: specs/tech/academy/[P1]derive_preview_conflict.md §2-§4（预检算法 + 裁决语义 + 补偿安全不变量）
 *       specs/api/overall/11a-squad-endpoints.md §2.5（preview endpoint + PreviewResult schema）
 *
 * 覆盖（task.json acceptanceCriteria）：
 *   1. previewDeriveAcademySeed：读两侧 + 同名检测；AGENTS.md 无 sameNameConflict；源缺失返空；校验失败 throw
 *   2. seedMemberWorkspaceFromVersion resolution 三档（merge/skip/overwrite）+ undefined 默认
 *   3. 补偿安全不变量：written 只含本次写入项（skip 不入 / 永不含团队根）；rmSync written 不动 squad 原有 + 不删团队根
 *   4. copyDirTrackingConditional 回归（源缺失返空 + 部分失败容忍）
 *   5. handleDeriveAcademyPreview：404 squad / 400 invalid_academy_source 三类 / 200 PreviewResult
 *
 * 文件系统隔离：mkdtempSync + afterEach rmSync（禁读写 ~/.oobt-desktop 等真实路径）。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { AcademyStore } from '../academy/academy-store';
import { SquadStore, squadRootDir } from '../stores/squad-store';
import { ulid } from '../config/ulid';
import {
  previewDeriveAcademySeed,
  seedMemberWorkspaceFromVersion,
  InvalidAcademySourceError,
} from '../services/member-academy-bridge';
import type { DeriveResolution } from '../services/member-academy-bridge';
import { handleDeriveAcademyPreview } from '../handlers/member-preview-handler';

/** 建一个 classroom + formal+active version（指向 sourceWorkspaceDir） */
async function setupAcademy(dataDir: string, workspaceDir: string, opts: {
  type?: 'formal' | 'process';
  status?: 'active' | 'adopted' | 'rejected';
  skipClassroom?: boolean;
} = {}): Promise<{ classroomId: string; studentId: string; versionId: string; academyStore: AcademyStore }> {
  const academyStore = new AcademyStore({ root: dataDir });
  const classroomId = ulid();
  const studentId = ulid();
  const versionId = ulid();
  if (!opts.skipClassroom) {
    await academyStore.putClassroom({
      id: classroomId, classroomId, name: 'c1', headTeacherSessionId: ulid(),
      datasetIds: [], graderIds: [], skillIds: [], archived: false,
    });
  }
  await academyStore.putVersion({
    id: versionId, studentId, classroomId, versionLabel: '1.0',
    type: opts.type ?? 'formal', workspaceDir, status: opts.status ?? 'active',
  });
  return { classroomId, studentId, versionId, academyStore };
}

/** 写源 workspace：AGENTS.md + .rocky/skills/<names>/skill.md + .rocky/memory/<names>/mem.md */
function writeSource(ws: string, skills: string[], memory: string[], withAgents = true): void {
  mkdirSync(ws, { recursive: true });
  if (withAgents) writeFileSync(join(ws, 'AGENTS.md'), 'student agents', 'utf8');
  for (const s of skills) {
    mkdirSync(join(ws, '.rocky', 'skills', s), { recursive: true });
    writeFileSync(join(ws, '.rocky', 'skills', s, 'skill.md'), `skill-${s}`, 'utf8');
  }
  for (const m of memory) {
    mkdirSync(join(ws, '.rocky', 'memory', m), { recursive: true });
    writeFileSync(join(ws, '.rocky', 'memory', m, 'mem.md'), `mem-${m}`, 'utf8');
  }
}

/** 在 squad 团队盘预置同名项（带 original 内容，验证 skip 不动它） */
function preSeedSquad(squadRoot: string, skills: string[], memory: string[]): void {
  for (const s of skills) {
    mkdirSync(join(squadRoot, '.rocky', 'skills', s), { recursive: true });
    writeFileSync(join(squadRoot, '.rocky', 'skills', s, 'original.md'), `orig-${s}`, 'utf8');
  }
  for (const m of memory) {
    mkdirSync(join(squadRoot, '.rocky', 'memory', m), { recursive: true });
    writeFileSync(join(squadRoot, '.rocky', 'memory', m, 'original.md'), `orig-${m}`, 'utf8');
  }
}

describe('[v0.0.233] previewDeriveAcademySeed — 读两侧 + 同名检测', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'rocky-preview-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('读源侧项 + 目标侧同名检测 → PreviewResult；AGENTS.md 无 sameNameConflict', async () => {
    const ws = join(dataDir, 'src-ws');
    writeSource(ws, ['skill-a', 'skill-b'], ['mem-1']);
    const squadRoot = squadRootDir(dataDir, 'sq1');
    preSeedSquad(squadRoot, ['skill-a'], []); // skill-a 同名，skill-b 不同名，mem-1 不同名
    const { classroomId, studentId, versionId, academyStore } = await setupAcademy(dataDir, ws);

    const result = await previewDeriveAcademySeed({
      academyStore, classroomId, studentId, versionId, squadRoot,
    });

    expect(result.agentsMd).toEqual({ exists: true }); // 无 sameNameConflict 字段
    expect(result.skills).toContainEqual({ name: 'skill-a', sameNameConflict: true });
    expect(result.skills).toContainEqual({ name: 'skill-b', sameNameConflict: false });
    expect(result.memory).toEqual([{ name: 'mem-1', sameNameConflict: false }]);
  });

  it('源缺失 .rocky/skills|.rocky/memory|AGENTS.md → 对应返空 / exists=false（不抛错）', async () => {
    const ws = join(dataDir, 'empty-ws');
    mkdirSync(ws, { recursive: true }); // 完全空，无 AGENTS.md 无 .rocky
    const squadRoot = squadRootDir(dataDir, 'sq2');
    const { classroomId, studentId, versionId, academyStore } = await setupAcademy(dataDir, ws);

    const result = await previewDeriveAcademySeed({
      academyStore, classroomId, studentId, versionId, squadRoot,
    });

    expect(result.agentsMd).toEqual({ exists: false });
    expect(result.skills).toEqual([]);
    expect(result.memory).toEqual([]);
  });

  it('version 非 formal+active → throw InvalidAcademySourceError（handler 转 400）', async () => {
    const ws = join(dataDir, 'ws3');
    writeSource(ws, [], []);
    const squadRoot = squadRootDir(dataDir, 'sq3');
    const f1 = await setupAcademy(dataDir, ws, { type: 'process' });
    await expect(previewDeriveAcademySeed({ ...f1, squadRoot })).rejects.toThrow(InvalidAcademySourceError);

    const f2 = await setupAcademy(dataDir, ws, { status: 'rejected' });
    await expect(previewDeriveAcademySeed({ ...f2, squadRoot })).rejects.toThrow(InvalidAcademySourceError);
  });

  it('classroom 不存在 → throw InvalidAcademySourceError', async () => {
    const ws = join(dataDir, 'ws4');
    writeSource(ws, [], []);
    const squadRoot = squadRootDir(dataDir, 'sq4');
    const { classroomId, studentId, versionId, academyStore } = await setupAcademy(dataDir, ws, { skipClassroom: true });
    await expect(previewDeriveAcademySeed({
      academyStore, classroomId, studentId, versionId, squadRoot,
    })).rejects.toThrow(InvalidAcademySourceError);
  });
});

describe('[v0.0.233] seedMemberWorkspaceFromVersion — resolution 三档 + 补偿安全不变量', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'rocky-seed-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('全不同名 + resolution undefined → 全 merge 入 written；团队根不入 written', async () => {
    const ws = join(dataDir, 'src');
    writeSource(ws, ['new-skill'], ['new-mem']);
    const squadRoot = squadRootDir(dataDir, 'sq');
    const { classroomId, versionId, academyStore } = await setupAcademy(dataDir, ws);

    const written = await seedMemberWorkspaceFromVersion({
      academyStore, classroomId, sourceVersionId: versionId, squadRoot,
      memberName: 'alice', memberId: ulid(),
      // resolution undefined = 默认全 skip 同名 + 不同名 merge
    });

    // 不同名项入 written（绝对路径）
    expect(written).toContain(join(squadRoot, '.rocky', 'skills', 'new-skill'));
    expect(written).toContain(join(squadRoot, '.rocky', 'memory', 'new-mem'));
    expect(written.some((p) => p.endsWith('AGENTS.md') || p.includes('.rocky/agents/'))).toBe(true);
    // 团队根本身永不入 written（补偿安全不变量 §4.3）
    expect(written).not.toContain(join(squadRoot, '.rocky', 'skills'));
    expect(written).not.toContain(join(squadRoot, '.rocky', 'memory'));
    expect(written).not.toContain(join(squadRoot, '.rocky', 'agents'));
    // 实际复制发生
    expect(existsSync(join(squadRoot, '.rocky', 'skills', 'new-skill', 'skill.md'))).toBe(true);
  });

  it('同名 + action=skip → 跳过不入 written，squad 原有不动；同名 + action=overwrite → 覆盖入 written', async () => {
    const ws = join(dataDir, 'src');
    writeSource(ws, ['conflict', 'to-overwrite'], ['conflict-mem']);
    const squadRoot = squadRootDir(dataDir, 'sq');
    // 预置 3 个同名项（验证 skip 不动 + overwrite 覆盖）
    preSeedSquad(squadRoot, ['conflict', 'to-overwrite'], ['conflict-mem']);

    const { classroomId, versionId, academyStore } = await setupAcademy(dataDir, ws);
    const resolution: DeriveResolution = {
      skills: [
        { name: 'conflict', action: 'skip' },
        { name: 'to-overwrite', action: 'overwrite' },
      ],
      memory: [{ name: 'conflict-mem', action: 'skip' }],
    };

    const written = await seedMemberWorkspaceFromVersion({
      academyStore, classroomId, sourceVersionId: versionId, squadRoot,
      memberName: 'bob', memberId: ulid(), resolution,
    });

    // skip 项不入 written
    expect(written).not.toContain(join(squadRoot, '.rocky', 'skills', 'conflict'));
    expect(written).not.toContain(join(squadRoot, '.rocky', 'memory', 'conflict-mem'));
    // overwrite 项入 written
    expect(written).toContain(join(squadRoot, '.rocky', 'skills', 'to-overwrite'));
    // skip 项 squad 原有内容保留
    expect(readFileSync(join(squadRoot, '.rocky', 'skills', 'conflict', 'original.md'), 'utf8')).toBe('orig-conflict');
    expect(readFileSync(join(squadRoot, '.rocky', 'memory', 'conflict-mem', 'original.md'), 'utf8')).toBe('orig-conflict-mem');
    // overwrite 项已被覆盖（学生内容落盘 + 原始文件名不存在，但目录下新文件存在）
    expect(existsSync(join(squadRoot, '.rocky', 'skills', 'to-overwrite', 'skill.md'))).toBe(true);
  });

  it('补偿安全不变量：rmSync(written) 不删 squad 原有同名项 + 不删团队根目录', async () => {
    const ws = join(dataDir, 'src');
    writeSource(ws, ['keep', 'add-new'], ['keep-mem']);
    const squadRoot = squadRootDir(dataDir, 'sq');
    preSeedSquad(squadRoot, ['keep'], ['keep-mem']); // keep / keep-mem 同名，默认 skip

    const { classroomId, versionId, academyStore } = await setupAcademy(dataDir, ws);
    const written = await seedMemberWorkspaceFromVersion({
      academyStore, classroomId, sourceVersionId: versionId, squadRoot,
      memberName: 'carol', memberId: ulid(),
    });

    // 模拟 member-service 补偿：rmSync each in written（force recursive）
    for (const p of written) rmSync(p, { recursive: true, force: true });

    // squad 原有同名项存活（skip 未入 written → 补偿不动它）
    expect(existsSync(join(squadRoot, '.rocky', 'skills', 'keep', 'original.md'))).toBe(true);
    expect(readFileSync(join(squadRoot, '.rocky', 'skills', 'keep', 'original.md'), 'utf8')).toBe('orig-keep');
    expect(existsSync(join(squadRoot, '.rocky', 'memory', 'keep-mem', 'original.md'))).toBe(true);
    // 团队根目录存活（written 永不含团队根本身）
    expect(existsSync(join(squadRoot, '.rocky', 'skills'))).toBe(true);
    expect(existsSync(join(squadRoot, '.rocky', 'memory'))).toBe(true);
    expect(existsSync(join(squadRoot, '.rocky', 'agents'))).toBe(true);
    // 本次新写入的项被补偿清理
    expect(existsSync(join(squadRoot, '.rocky', 'skills', 'add-new'))).toBe(false);
  });

  it('copyDirTrackingConditional 源缺失返空 + 部分失败容忍（不抛错、不回归）', async () => {
    // 源 .rocky/skills 缺失（仅 memory），验证 skills 返空不抛
    const ws = join(dataDir, 'partial-src');
    mkdirSync(join(ws, '.rocky', 'memory', 'only-mem'), { recursive: true });
    writeFileSync(join(ws, '.rocky', 'memory', 'only-mem', 'mem.md'), 'm', 'utf8');
    const squadRoot = squadRootDir(dataDir, 'sq');
    const { classroomId, versionId, academyStore } = await setupAcademy(dataDir, ws);

    const written = await seedMemberWorkspaceFromVersion({
      academyStore, classroomId, sourceVersionId: versionId, squadRoot,
      memberName: 'dave', memberId: ulid(),
    });
    // memory 复制成功入 written；skills 源缺失返空（不抛错）
    expect(written).toContain(join(squadRoot, '.rocky', 'memory', 'only-mem'));
    expect(existsSync(join(squadRoot, '.rocky', 'memory', 'only-mem', 'mem.md'))).toBe(true);
  });

  it('部分复制失败容忍：单项复制失败 catch 不抛，其他项仍入 written（不回归）', async () => {
    const ws = join(dataDir, 'src');
    writeSource(ws, ['good', 'locked'], []);
    // 让 src/locked/skill.md 不可读（chmod 000）→ copyFile 读失败 → copyDirRecursive throw → catch
    const lockedFile = join(ws, '.rocky', 'skills', 'locked', 'skill.md');
    const squadRoot = squadRootDir(dataDir, 'sq');
    const { classroomId, versionId, academyStore } = await setupAcademy(dataDir, ws);
    chmodSync(lockedFile, 0o000);
    try {
      const written = await seedMemberWorkspaceFromVersion({
        academyStore, classroomId, sourceVersionId: versionId, squadRoot,
        memberName: 'eve', memberId: ulid(),
      });
      // good 复制成功入 written（locked 失败不影响其他项）
      expect(written).toContain(join(squadRoot, '.rocky', 'skills', 'good'));
      // locked 的 skill.md 未落盘（src 不可读 → copyFile 失败）— 验证失败路径被真实触发
      expect(existsSync(join(squadRoot, '.rocky', 'skills', 'locked', 'skill.md'))).toBe(false);
    } finally {
      chmodSync(lockedFile, 0o644);
    }
  });
});

describe('[v0.0.233] handleDeriveAcademyPreview — HTTP 端点', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'rocky-prev-h-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  /** 建一个最小 squad record（preview handler 校验 squad 存在用） */
  async function putSquad(squadId: string): Promise<void> {
    const store = new SquadStore({ root: dataDir });
    await store.putSquad({
      id: squadId, name: 'squad', modelDefault: 'm', leaderId: ulid(),
      memberIds: [], squadChatSessionId: ulid(),
      charter: { goals: '', workingStyle: '', collaboration: '', escalation: '' },
      enableHeartBeat: false,
    } as Parameters<typeof store.putSquad>[0]);
  }

  function deps(): { sessionStore: unknown; dataDir: string } {
    return { sessionStore: {}, dataDir }; // preview handler 仅用 dataDir
  }

  it('squad 不存在 → 404 squad not found', async () => {
    const res = await handleDeriveAcademyPreview(
      new Request('https://x/squad/sq/member/derive-academy/preview', {
        method: 'POST',
        body: JSON.stringify({ classroomId: 'c', studentId: 's', versionId: 'v' }),
      }),
      'nonexistent-squad',
      deps() as never,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'squad not found' });
  });

  it('三字段任一缺 → 400 invalid_academy_source', async () => {
    const squadId = ulid();
    await putSquad(squadId);
    const res = await handleDeriveAcademyPreview(
      new Request('https://x/preview', {
        method: 'POST',
        body: JSON.stringify({ classroomId: 'c', studentId: 's' }), // 缺 versionId
      }),
      squadId,
      deps() as never,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_academy_source');
  });

  it('version 非 formal+active → 400 invalid_academy_source', async () => {
    const squadId = ulid();
    await putSquad(squadId);
    const ws = join(dataDir, 'ws');
    writeSource(ws, [], []);
    const fix = await setupAcademy(dataDir, ws, { type: 'process' });
    const res = await handleDeriveAcademyPreview(
      new Request('https://x/preview', {
        method: 'POST',
        body: JSON.stringify({ classroomId: fix.classroomId, studentId: fix.studentId, versionId: fix.versionId }),
      }),
      squadId,
      deps() as never,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_academy_source');
  });

  it('classroom 不存在 → 400 invalid_academy_source', async () => {
    const squadId = ulid();
    await putSquad(squadId);
    const ws = join(dataDir, 'ws');
    writeSource(ws, [], []);
    const fix = await setupAcademy(dataDir, ws, { skipClassroom: true });
    const res = await handleDeriveAcademyPreview(
      new Request('https://x/preview', {
        method: 'POST',
        body: JSON.stringify({ classroomId: fix.classroomId, studentId: fix.studentId, versionId: fix.versionId }),
      }),
      squadId,
      deps() as never,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_academy_source');
  });

  it('全字段有效 → 200 + PreviewResult', async () => {
    const squadId = ulid();
    await putSquad(squadId);
    const ws = join(dataDir, 'ws');
    writeSource(ws, ['s1'], ['m1']);
    const fix = await setupAcademy(dataDir, ws);
    const res = await handleDeriveAcademyPreview(
      new Request('https://x/preview', {
        method: 'POST',
        body: JSON.stringify({ classroomId: fix.classroomId, studentId: fix.studentId, versionId: fix.versionId }),
      }),
      squadId,
      deps() as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agentsMd: { exists: boolean };
      skills: Array<{ name: string; sameNameConflict: boolean }>;
      memory: Array<{ name: string; sameNameConflict: boolean }>;
    };
    expect(body.agentsMd).toEqual({ exists: true });
    expect(body.skills).toEqual([{ name: 's1', sameNameConflict: false }]);
    expect(body.memory).toEqual([{ name: 'm1', sameNameConflict: false }]);
  });
});
