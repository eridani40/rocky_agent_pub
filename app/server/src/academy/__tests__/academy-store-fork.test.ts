/**
 * AcademyStore fork/adopt 单测（白盒）— INV-5/INV-6 不变量
 * 参考: specs/tech/academy/[P0]data_model.md §6（fork/adopt 接口）+ §8（不变量）
 *       specs/tech/academy/[P0]training_engine.md §3（multi-turn 迭代：round 2+ fork process base）
 *
 * 覆盖：
 *   - createInitialFormalVersion：0.0 空版本骨架（graceful）
 *   - forkVersionWorkspace：formal/process base 均 OK + workspaceDir 复制 + dst 非空抛错（INV-5）
 *   - adoptToFormal：复制为新 formal 版本（label 自增）+ 原 process status='adopted'（INV-6）
 *   - academy-paths 路径形态
 *
 * 基础 CRUD 在 academy-store-crud.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { AcademyStore } from '../academy-store';
import {
  forkVersionWorkspace,
  adoptToFormal,
  createInitialFormalVersion,
} from '../academy-store-ops';
import {
  formalVersionWorkspaceDir,
  processVersionWorkspaceDir,
  classroomRoot,
} from '../academy-paths';
import { writeVersionDirFiles, resolveVersionContent } from '../academy-version-dir';
import { ulid } from '../../config/ulid';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-fork-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('createInitialFormalVersion — 0.0 空版本骨架', () => {
  it('建 workspace + version.json（无 AGENTS.md）+ record', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId, workspaceDir } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'gpt-4' },
    );
    expect(fs.existsSync(workspaceDir)).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, 'version.json'))).toBe(true);
    // AGENTS.md 不应存在（0.0 空版本 graceful）
    expect(fs.existsSync(path.join(workspaceDir, 'AGENTS.md'))).toBe(false);

    const got = await store.getVersion(cid, versionId);
    expect(got?.versionLabel).toBe('0.0');
    expect(got?.type).toBe('formal');

    const content = await resolveVersionContent(workspaceDir);
    expect(content.agentsMd).toBe('');
    expect(content.versionJson?.model.modelId).toBe('gpt-4');
  });
});

describe('forkVersionWorkspace — base→process（INV-5 原子性）', () => {
  it('正常 fork：base formal → process 版本', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId: baseId } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'gpt-4' },
    );

    const result = await forkVersionWorkspace(
      store, tmpRoot, baseId, cid, sid, 1, 1, ulid(),
    );
    expect(result.versionId).toBeTruthy();
    expect(fs.existsSync(result.workspaceDir)).toBe(true);
    // 路径形态：academy/{cid}/students/{sid}/versions/.work/{base}.{taskSeq}/{round}/ws/
    expect(result.workspaceDir).toContain('.work/0.0.1/1/ws');

    const newVer = await store.getVersion(cid, result.versionId);
    expect(newVer?.type).toBe('process');
    expect(newVer?.parentFormalVersionId).toBe(baseId);
    expect(newVer?.taskSeq).toBe(1);
    expect(newVer?.roundNumber).toBe(1);
    expect(newVer?.status).toBe('active');
  });

  it('fork 保留 base 版本的 workspace 内容', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId: baseId, workspaceDir: baseWs } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'm1' },
    );
    // 往 base workspace 补写 AGENTS.md（模拟 head 编辑）
    await writeVersionDirFiles(baseWs, {
      versionLabel: '0.0',
      model: { modelId: 'm1' },
      agentsMd: '# Student Prompt',
    });

    const result = await forkVersionWorkspace(
      store, tmpRoot, baseId, cid, sid, 1, 1, ulid(),
    );
    const content = await resolveVersionContent(result.workspaceDir);
    expect(content.agentsMd).toBe('# Student Prompt');
  });

  it('fork 允许 process base（multi-turn 迭代：round 2+ 临时基线为 process，对齐 training_engine §3）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId: baseId, workspaceDir: baseWs } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'm1' },
    );
    // 给 formal base 写点内容，验证 multi-turn 链式 fork 内容透传
    await writeVersionDirFiles(baseWs, {
      versionLabel: '0.0',
      model: { modelId: 'm1' },
      agentsMd: '# round 0',
    });
    // round 1：formal → process1（base.type=formal）
    const process1 = await forkVersionWorkspace(
      store, tmpRoot, baseId, cid, sid, 1, 1, ulid(),
    );
    // round 2：process1 → process2（base.type=process；multi-turn 迭代的核心需求）
    const process2 = await forkVersionWorkspace(
      store, tmpRoot, process1.versionId, cid, sid, 1, 2, ulid(),
    );
    expect(process2.versionId).toBeTruthy();
    expect(fs.existsSync(process2.workspaceDir)).toBe(true);

    // 内容链式透传：base formal → process1 → process2
    const content2 = await resolveVersionContent(process2.workspaceDir);
    expect(content2.agentsMd).toBe('# round 0');

    // 新版本仍标记为 process（fork 永远产 process；不依赖 base 类型）
    const newVer = await store.getVersion(cid, process2.versionId);
    expect(newVer?.type).toBe('process');
    expect(newVer?.taskSeq).toBe(1);
    expect(newVer?.roundNumber).toBe(2);
    expect(newVer?.status).toBe('active');
    // parentFormalVersionId 字段语义 = 「fork base id」（spec §3 字段注释）；
    // multi-turn 场景指向上一轮 process（schema 仅要求 ulid + 必填，不约束指向类型）
    expect(newVer?.parentFormalVersionId).toBe(process1.versionId);
  });

  it('fork dst 非空抛错（INV-5 防覆盖）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId: baseId } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'm1' },
    );
    // 第一次 fork 成功
    await forkVersionWorkspace(store, tmpRoot, baseId, cid, sid, 1, 1, ulid());
    // 第二次同 base+taskSeq+round fork 应抛错（dst 已存在且非空）
    await expect(
      forkVersionWorkspace(store, tmpRoot, baseId, cid, sid, 1, 1, ulid()),
    ).rejects.toThrow(/already exists and is not empty/);
  });
});

describe('forkVersionWorkspace versionLabel 3 段化（v0.0.213）— base顶层major.taskSeq.round', () => {
  it('base "0.0" → versionLabel "0.1.1"（不拼完整 base label）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId: baseId } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'm1' },
    );
    const result = await forkVersionWorkspace(
      store, tmpRoot, baseId, cid, sid, 1, 1, ulid(),
    );
    const v = await store.getVersion(cid, result.versionId);
    expect(v?.versionLabel).toBe('0.1.1');
    expect(v?.versionLabel.split('.')).toHaveLength(3); // 恒 3 段
  });

  it('base "1.0" → versionLabel "1.x.y"（顶层 major=1）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId: baseId } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'm1' },
    );
    // 覆盖 base label 为 1.0（建一个 1.0 formal 版本作 fork base）
    const formalVid = ulid();
    const formalWs = path.join(tmpRoot, 'academy', cid, 'students', sid, 'versions', '1.0', 'ws');
    await writeVersionDirFiles(formalWs, { versionLabel: '1.0', model: { modelId: 'm1' } });
    await store.putVersion({
      id: formalVid, studentId: sid, classroomId: cid,
      versionLabel: '1.0', type: 'formal', workspaceDir: formalWs, status: 'active',
    });
    const result = await forkVersionWorkspace(
      store, tmpRoot, formalVid, cid, sid, 2, 3, ulid(),
    );
    const v = await store.getVersion(cid, result.versionId);
    expect(v?.versionLabel).toBe('1.2.3'); // major=1, taskSeq=2, round=3
    expect(v?.versionLabel.split('.')).toHaveLength(3);
  });

  it('multi-turn base 是 process 版（如 "0.1.1"）→ 只取顶层 major "0"，不段数爆炸', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId: baseId } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'm1' },
    );
    // round1：base 0.0 → process "0.1.1"
    const p1 = await forkVersionWorkspace(store, tmpRoot, baseId, cid, sid, 1, 1, ulid());
    const v1 = await store.getVersion(cid, p1.versionId);
    expect(v1?.versionLabel).toBe('0.1.1');
    // round2：base 是 round1 process（label "0.1.1"）→ 旧 bug 拼 "0.1.1.1.2" 5 段；修复后 "0.1.2"
    const p2 = await forkVersionWorkspace(store, tmpRoot, p1.versionId, cid, sid, 1, 2, ulid());
    const v2 = await store.getVersion(cid, p2.versionId);
    expect(v2?.versionLabel).toBe('0.1.2'); // 只取顶层 major=0，恒 3 段
    expect(v2?.versionLabel.split('.')).toHaveLength(3);
  });

  it('dst 目录路径仍用 base 完整 label（路径唯一性不变）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId: baseId } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'm1' },
    );
    // base label "0.0" → 路径 .work/0.0.1/1/ws（路径用完整 base label，versionLabel 字段用 3 段）
    const result = await forkVersionWorkspace(
      store, tmpRoot, baseId, cid, sid, 1, 1, ulid(),
    );
    expect(result.workspaceDir).toContain('.work/0.0.1/1/ws');
  });
});

describe('adoptToFormal — process→formal 复制（INV-6 不 rename 原 process）', () => {
  it('正常 adopt：process → 新 formal 版本（label 自增）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId: baseId } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'm1' },
    );
    const proc = await forkVersionWorkspace(
      store, tmpRoot, baseId, cid, sid, 1, 1, ulid(),
    );

    const result = await adoptToFormal(store, tmpRoot, cid, proc.versionId);
    expect(result.newLabel).toBe('1.0');
    expect(fs.existsSync(result.newWorkspaceDir)).toBe(true);
    expect(result.newWorkspaceDir).toContain('/versions/1.0/ws');

    const newFormal = await store.getVersion(cid, result.newFormalVersionId);
    expect(newFormal?.type).toBe('formal');
    expect(newFormal?.versionLabel).toBe('1.0');
    expect(newFormal?.status).toBe('active');
  });

  it('INV-6：原 process 目录保留 + status=adopted（不 rename）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId: baseId } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'm1' },
    );
    const proc = await forkVersionWorkspace(
      store, tmpRoot, baseId, cid, sid, 1, 1, ulid(),
    );
    const procWorkspaceDir = proc.workspaceDir;

    await adoptToFormal(store, tmpRoot, cid, proc.versionId);

    // 原 process 目录仍存在（不删不 rename）
    expect(fs.existsSync(procWorkspaceDir)).toBe(true);
    // 原 process record status='adopted'
    const procRecord = await store.getVersion(cid, proc.versionId);
    expect(procRecord?.status).toBe('adopted');
    expect(procRecord?.type).toBe('process'); // 类型不变
  });

  it('连续 adopt：第二次自增到 2.0（找下一个空正式版号）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId: baseId } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'm1' },
    );
    const proc1 = await forkVersionWorkspace(
      store, tmpRoot, baseId, cid, sid, 1, 1, ulid(),
    );
    const r1 = await adoptToFormal(store, tmpRoot, cid, proc1.versionId);
    expect(r1.newLabel).toBe('1.0');

    // 在新 1.0 上再 fork + adopt → 应得 2.0
    const proc2 = await forkVersionWorkspace(
      store, tmpRoot, r1.newFormalVersionId, cid, sid, 2, 1, ulid(),
    );
    const r2 = await adoptToFormal(store, tmpRoot, cid, proc2.versionId);
    expect(r2.newLabel).toBe('2.0');
  });

  it('adopt 拒绝 formal 版本（必须 process）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId: baseId } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'm1' },
    );
    await expect(adoptToFormal(store, tmpRoot, cid, baseId)).rejects.toThrow(/必须是 process/);
  });
});

describe('adoptToFormal — adoptedFromProcessVersionId 溯源字段（v0.0.219）', () => {
  it('adopt 后新 formal record.adoptedFromProcessVersionId === 原 process id', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId: baseId } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'm1' },
    );
    const proc = await forkVersionWorkspace(
      store, tmpRoot, baseId, cid, sid, 1, 1, ulid(),
    );
    const result = await adoptToFormal(store, tmpRoot, cid, proc.versionId);

    const newFormal = await store.getVersion(cid, result.newFormalVersionId);
    expect(newFormal?.type).toBe('formal');
    expect(newFormal?.adoptedFromProcessVersionId).toBe(proc.versionId);
  });

  it('createInitialFormalVersion 0.0 不写 adoptedFromProcessVersionId（初始版本无采纳源）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid();
    const { versionId } = await createInitialFormalVersion(
      store, tmpRoot, cid, sid, { modelId: 'm1' },
    );
    const v = await store.getVersion(cid, versionId);
    expect(v?.adoptedFromProcessVersionId).toBeUndefined();
  });
});

describe('academy-paths — 路径生成单点', () => {
  it('classroomRoot 路径形态', () => {
    expect(classroomRoot('/data', 'cid1')).toBe('/data/academy/cid1');
  });
  it('formalVersionWorkspaceDir 路径形态', () => {
    expect(formalVersionWorkspaceDir('/data', 'cid', 'sid', '1.0'))
      .toBe('/data/academy/cid/students/sid/versions/1.0/ws');
  });
  it('processVersionWorkspaceDir 路径形态', () => {
    const p = processVersionWorkspaceDir('/data', 'cid', 'sid', '1.0', 2, 3);
    expect(p).toBe('/data/academy/cid/students/sid/versions/.work/1.0.2/3/ws');
  });
});
