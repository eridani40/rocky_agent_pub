/**
 * AcademyStore CRUD 单测（白盒）— 7 entity 基础 CRUD + 分片隔离
 * 参考: specs/tech/academy/[P0]data_model.md §1-§7（entity 定义 + 落盘布局）
 *       specs/tech/version_logs/v0.0.210/change_plan.md K 节
 *
 * 覆盖：
 *   - 7 entity put/get/list
 *   - shardKey=classroomId 分片隔离（不同 classroom 数据互不影响）
 *   - 落盘路径形态（{root}/academy/{cid}/<entity>/{id}.json）
 *
 * fork/adopt 测试在 academy-store-fork.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { AcademyStore } from '../academy-store';
import { ulid } from '../../config/ulid';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-crud-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function mkClassroom(id: string, name: string) {
  return { id, classroomId: id, name, headTeacherSessionId: ulid(), logo: '🎓' };
}
function mkStudent(classroomId: string, name: string) {
  return { id: ulid(), classroomId, name };
}

describe('AcademyStore — classroom CRUD', () => {
  it('putClassroom + getClassroom 命中，落盘路径形态校验', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid();
    await store.putClassroom(mkClassroom(cid, 'maths'));
    const got = await store.getClassroom(cid);
    expect(got?.name).toBe('maths');
    expect(got?.version).toBe(1);
    // 落盘路径：{root}/academy/{cid}/classroom/{cid}.json
    expect(fs.existsSync(path.join(tmpRoot, 'academy', cid, 'classroom', `${cid}.json`))).toBe(true);
  });

  it('listClassrooms 按 ULID 倒序（后建排前）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const a = await store.putClassroom(mkClassroom(ulid(), 'a'));
    const b = await store.putClassroom(mkClassroom(ulid(), 'b'));
    const list = await store.listClassrooms();
    expect(list.length).toBe(2);
    expect(list[0]!.id).toBe(b.id);
    expect(list[1]!.id).toBe(a.id);
  });

  it('getClassroom 不存在返 undefined', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    expect(await store.getClassroom(ulid())).toBeUndefined();
  });
});

describe('AcademyStore — student/student_version CRUD（按 classroomId 分片）', () => {
  it('listStudentsByClassroom 仅返该 classroom（分片隔离）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cidA = ulid(), cidB = ulid();
    await store.putStudent(mkStudent(cidA, 'a1'));
    await store.putStudent(mkStudent(cidA, 'a2'));
    await store.putStudent(mkStudent(cidB, 'b1'));
    expect((await store.listStudentsByClassroom(cidA)).length).toBe(2);
    expect((await store.listStudentsByClassroom(cidB)).length).toBe(1);
  });

  it('putVersion + getVersion round-trip', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid(), vid = ulid();
    await store.putVersion({
      id: vid, studentId: sid, classroomId: cid,
      versionLabel: '0.0', type: 'formal',
      workspaceDir: '/tmp/ws',
    });
    const got = await store.getVersion(cid, vid);
    expect(got?.versionLabel).toBe('0.0');
    expect(got?.type).toBe('formal');
  });

  it('listVersions 按 studentId 线性过滤（含 process）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid1 = ulid(), sid2 = ulid();
    await store.putVersion({
      id: ulid(), studentId: sid1, classroomId: cid,
      versionLabel: '0.0', type: 'formal', workspaceDir: '/tmp/a',
    });
    await store.putVersion({
      id: ulid(), studentId: sid1, classroomId: cid,
      versionLabel: '0.0.1.1', type: 'process', workspaceDir: '/tmp/b',
    });
    await store.putVersion({
      id: ulid(), studentId: sid2, classroomId: cid,
      versionLabel: '0.0', type: 'formal', workspaceDir: '/tmp/c',
    });
    expect((await store.listVersions(cid, sid1)).length).toBe(2);
    expect((await store.listVersions(cid, sid2)).length).toBe(1);
  });
});

describe('AcademyStore — training_task + training_turn CRUD', () => {
  it('putTask + getTask + listTasksByClassroom', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid(), tid = ulid();
    await store.putTask({
      id: tid, classroomId: cid, studentId: sid,
      baseVersionId: ulid(), taskSeq: 1, coachSessionId: ulid(),
      mode: 'multi', optimizeStyle: 'training', status: 'pending',
    });
    expect((await store.getTask(cid, tid))?.mode).toBe('multi');
    expect((await store.listTasksByClassroom(cid)).length).toBe(1);
  });

  it('listTasksByCoach 按 coachSessionId 过滤', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), coachA = ulid(), coachB = ulid();
    for (const c of [coachA, coachA, coachB]) {
      await store.putTask({
        id: ulid(), classroomId: cid, studentId: ulid(),
        baseVersionId: ulid(), taskSeq: 1, coachSessionId: c,
        mode: 'multi', optimizeStyle: 'training', status: 'pending',
      });
    }
    expect((await store.listTasksByCoach(coachA)).length).toBe(2);
    expect((await store.listTasksByCoach(coachB)).length).toBe(1);
  });

  it('appendTurn + getTurn + listTurns 按 round asc', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), sid = ulid(), tid = ulid();
    // 先建 task（外键关联）
    await store.putTask({
      id: tid, classroomId: cid, studentId: sid,
      baseVersionId: ulid(), taskSeq: 1, coachSessionId: ulid(),
      mode: 'multi', optimizeStyle: 'training', status: 'pending',
    });
    // 建 turn 2 再建 turn 1（验证按 round 排序）
    for (const round of [2, 1]) {
      await store.appendTurn({
        id: ulid(), taskId: tid, classroomId: cid, studentId: sid,
        round, candidateVersionId: ulid(), status: 'running',
      });
    }
    const turn1 = await store.getTurn(cid, tid, 1);
    expect(turn1?.round).toBe(1);
    const turns = await store.listTurns(cid, tid);
    expect(turns.length).toBe(2);
    expect(turns[0]!.round).toBe(1); // asc
    expect(turns[1]!.round).toBe(2);
  });
});

describe('AcademyStore — dataset + grader CRUD', () => {
  it('putDataset + getDataset（items json 透传）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), did = ulid();
    await store.putDataset({
      id: did, classroomId: cid, name: 'ds1',
      items: [{ id: 'q1', question: '2+2?' }],
    });
    const ds = await store.getDataset(cid, did);
    expect(ds?.name).toBe('ds1');
    expect((ds?.items as Array<{ id: string }>).length).toBe(1);
  });

  it('putGrader + getGrader（type enum 闭合）', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid(), gid = ulid();
    await store.putGrader({
      id: gid, classroomId: cid, name: 'g1', type: 'llm-judge',
      promptTemplate: 'eval {question}',
    });
    expect((await store.getGrader(cid, gid))?.type).toBe('llm-judge');
  });

  it('listDatasetsByClassroom + listGradersByClassroom 分片', async () => {
    const store = new AcademyStore({ root: tmpRoot });
    const cid = ulid();
    await store.putDataset({
      id: ulid(), classroomId: cid, name: 'ds', items: [],
    });
    await store.putGrader({
      id: ulid(), classroomId: cid, name: 'g', type: 'em',
    });
    expect((await store.listDatasetsByClassroom(cid)).length).toBe(1);
    expect((await store.listGradersByClassroom(cid)).length).toBe(1);
  });
});
