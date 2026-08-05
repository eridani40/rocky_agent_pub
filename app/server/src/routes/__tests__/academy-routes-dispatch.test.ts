/**
 * academy-routes dispatch 单测 — 最长前缀优先分发（堵「handler UT 直调不过 dispatch」盲区）
 * 参考: specs/api/overall/18-academy.md（端点契约）
 *       states/v0.0.210/verify/review/code-review-task1.md Critical（generic 前缀抢跑吞深层路径）
 *
 * 策略：vi.mock 4 个 handler 模块（__dirname 绝对路径——相对路径在 bun+jsdom 全量并发下
 *       会静默失效，见 consolidation-handler.test.ts 同款模式），每个 mock 返专属 marker
 *       Response；对 18-academy.md 每个声明端点断言：
 *         ① 命中正确 handler（不返 null、不误分发）
 *         ② 透传参数原样（req/method/path/deps）
 *         ③ 其余 3 个 handler 未被调用
 *       dispatch 只按 path 分发（method 透传给 handler 判 405），故每端点测代表性 method。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── mock 4 个 handler 模块（各自返 marker Response）──────────────
vi.mock(require('path').resolve(__dirname, '../../handlers/academy-classroom'), () => ({
  handleClassroomRoute: vi.fn(async () =>
    new Response(JSON.stringify({ handler: 'classroom' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })),
}));
vi.mock(require('path').resolve(__dirname, '../../handlers/academy-student'), () => ({
  handleStudentRoute: vi.fn(async () =>
    new Response(JSON.stringify({ handler: 'student' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })),
}));
vi.mock(require('path').resolve(__dirname, '../../handlers/academy-training-task'), () => ({
  handleTrainingTaskRoute: vi.fn(async () =>
    new Response(JSON.stringify({ handler: 'task' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })),
}));
vi.mock(require('path').resolve(__dirname, '../../handlers/academy-assets'), () => ({
  handleAssetsRoute: vi.fn(async () =>
    new Response(JSON.stringify({ handler: 'assets' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })),
}));

import {
  dispatchAcademyRoutes,
  registerAcademyRoutes,
  type AcademyHandlerDeps,
} from '../academy-routes';
import { handleClassroomRoute } from '../../handlers/academy-classroom';
import { handleStudentRoute } from '../../handlers/academy-student';
import { handleTrainingTaskRoute } from '../../handlers/academy-training-task';
import { handleAssetsRoute } from '../../handlers/academy-assets';

const mocks = {
  classroom: vi.mocked(handleClassroomRoute),
  student: vi.mocked(handleStudentRoute),
  task: vi.mocked(handleTrainingTaskRoute),
  assets: vi.mocked(handleAssetsRoute),
};
type HandlerKind = keyof typeof mocks;

/** mock handler 不消费 deps，占位即可 */
const deps: AcademyHandlerDeps = {
  academyStore: {} as AcademyHandlerDeps['academyStore'],
  trainingEngine: {} as AcademyHandlerDeps['trainingEngine'],
  agentManager: {} as AcademyHandlerDeps['agentManager'],
  sessionStore: {} as AcademyHandlerDeps['sessionStore'],
  appConfig: {} as AcademyHandlerDeps['appConfig'],
  dataDir: '/nonexistent-dispatch-test',
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockClear();
});

/** 18-academy.md 全声明端点 → 期望 handler（CID/SID/VID/TID/DID/GID 占位段） */
const CASES: Array<{ endpoint: string; method: string; path: string; want: HandlerKind }> = [
  // §1.1-1.6 classroom 浅层（classroom handler 只认这 3 种形态）
  { endpoint: '§1.1 POST /academy/classroom', method: 'POST', path: '/academy/classroom', want: 'classroom' },
  { endpoint: '§1.2 GET /academy/classroom', method: 'GET', path: '/academy/classroom', want: 'classroom' },
  { endpoint: '§1.3 GET /academy/classroom/:cid', method: 'GET', path: '/academy/classroom/CID', want: 'classroom' },
  { endpoint: '§1.4 PATCH /academy/classroom/:cid', method: 'PATCH', path: '/academy/classroom/CID', want: 'classroom' },
  { endpoint: '§1.5 POST /academy/classroom/:cid/student', method: 'POST', path: '/academy/classroom/CID/student', want: 'classroom' },
  { endpoint: '§1.6 GET /academy/classroom/:cid/student', method: 'GET', path: '/academy/classroom/CID/student', want: 'classroom' },
  // §1.7-1.10 student/version 深层（review Critical 实证 404 组）
  { endpoint: '§1.7 GET .../student/:sid', method: 'GET', path: '/academy/classroom/CID/student/SID', want: 'student' },
  { endpoint: '§1.8 GET .../version/:vid', method: 'GET', path: '/academy/classroom/CID/student/SID/version/VID', want: 'student' },
  { endpoint: '§1.9 PATCH .../version/:vid', method: 'PATCH', path: '/academy/classroom/CID/student/SID/version/VID', want: 'student' },
  { endpoint: '§1.10 POST .../version/:vid/session', method: 'POST', path: '/academy/classroom/CID/student/SID/version/VID/session', want: 'student' },
  // §2 training-task（§2.1 创建走 classroom 嵌套路径——review 断掉的主路径）
  // v0.0.221：accept/reject/stop → adopt/pause/resume/update-task（两轴模型）
  { endpoint: '§2.1 POST .../student/:sid/training-task', method: 'POST', path: '/academy/classroom/CID/student/SID/training-task', want: 'task' },
  { endpoint: '§2.2 GET /academy/training-task/:tid', method: 'GET', path: '/academy/training-task/TID', want: 'task' },
  { endpoint: '§2.3 POST .../revise', method: 'POST', path: '/academy/training-task/TID/revise', want: 'task' },
  { endpoint: '§2.4 POST .../adopt', method: 'POST', path: '/academy/training-task/TID/adopt', want: 'task' },
  { endpoint: '§2.5 POST .../pause', method: 'POST', path: '/academy/training-task/TID/pause', want: 'task' },
  { endpoint: '§2.6 POST .../resume', method: 'POST', path: '/academy/training-task/TID/resume', want: 'task' },
  { endpoint: '§2.7 POST .../update-task', method: 'POST', path: '/academy/training-task/TID/update-task', want: 'task' },
  { endpoint: '§2.8 POST .../inject-directive', method: 'POST', path: '/academy/training-task/TID/inject-directive', want: 'task' },
  // §3 dataset（collection + item 全 CRUD）
  { endpoint: '§3.1 POST .../dataset', method: 'POST', path: '/academy/classroom/CID/dataset', want: 'assets' },
  { endpoint: '§3.2 GET .../dataset', method: 'GET', path: '/academy/classroom/CID/dataset', want: 'assets' },
  { endpoint: '§3.3 GET .../dataset/:did', method: 'GET', path: '/academy/classroom/CID/dataset/DID', want: 'assets' },
  { endpoint: '§3.4 PATCH .../dataset/:did', method: 'PATCH', path: '/academy/classroom/CID/dataset/DID', want: 'assets' },
  { endpoint: '§3.5 DELETE .../dataset/:did', method: 'DELETE', path: '/academy/classroom/CID/dataset/DID', want: 'assets' },
  // §3.6-3.10 grader（结构同 dataset）
  { endpoint: '§3.6 POST .../grader', method: 'POST', path: '/academy/classroom/CID/grader', want: 'assets' },
  { endpoint: '§3.7 GET .../grader', method: 'GET', path: '/academy/classroom/CID/grader', want: 'assets' },
  { endpoint: '§3.8 GET .../grader/:gid', method: 'GET', path: '/academy/classroom/CID/grader/GID', want: 'assets' },
  { endpoint: '§3.9 PATCH .../grader/:gid', method: 'PATCH', path: '/academy/classroom/CID/grader/GID', want: 'assets' },
  { endpoint: '§3.10 DELETE .../grader/:gid', method: 'DELETE', path: '/academy/classroom/CID/grader/GID', want: 'assets' },
];

describe('dispatchAcademyRoutes — 18-academy.md 全端点分发（不 404、不误分发）', () => {
  for (const c of CASES) {
    it(`${c.endpoint} → ${c.want} handler`, async () => {
      const req = new Request(`http://test${c.path}`, { method: c.method });
      const r = await dispatchAcademyRoutes(req, c.method, c.path, deps);
      expect(r).not.toBeNull();
      expect(await r!.json()).toEqual({ handler: c.want });
      // 透传参数原样
      expect(mocks[c.want]).toHaveBeenCalledTimes(1);
      expect(mocks[c.want]).toHaveBeenCalledWith(req, c.method, c.path, deps);
      // 其余 handler 未被调用
      for (const [kind, m] of Object.entries(mocks)) {
        if (kind !== c.want) expect(m).not.toHaveBeenCalled();
      }
    });
  }
});

describe('dispatchAcademyRoutes — 边界', () => {
  it('非 /academy 前缀 → null（主分发继续下个 group）', async () => {
    expect(await dispatchAcademyRoutes(new Request('http://test/session'), 'GET', '/session', deps)).toBeNull();
    expect(await dispatchAcademyRoutes(new Request('http://test/squad/SQ/member', { method: 'POST' }), 'POST', '/squad/SQ/member', deps)).toBeNull();
    for (const m of Object.values(mocks)) expect(m).not.toHaveBeenCalled();
  });

  it('/academy 下未识别子路径 → null', async () => {
    const r = await dispatchAcademyRoutes(new Request('http://test/academy/other'), 'GET', '/academy/other', deps);
    expect(r).toBeNull();
    for (const m of Object.values(mocks)) expect(m).not.toHaveBeenCalled();
  });

  it('classroom 深层未识别路径 → classroom handler 兜底（其内部判 404）', async () => {
    const r = await dispatchAcademyRoutes(new Request('http://test/academy/classroom/CID/bogus'), 'GET', '/academy/classroom/CID/bogus', deps);
    expect(await r!.json()).toEqual({ handler: 'classroom' });
    expect(mocks.classroom).toHaveBeenCalledTimes(1);
  });

  it('method 不参与分发：DELETE .../student/:sid 仍派 student handler（由其判 405）', async () => {
    const path = '/academy/classroom/CID/student/SID';
    const r = await dispatchAcademyRoutes(new Request(`http://test${path}`, { method: 'DELETE' }), 'DELETE', path, deps);
    expect(await r!.json()).toEqual({ handler: 'student' });
    expect(mocks.student).toHaveBeenCalledTimes(1);
  });

  it('registerAcademyRoutes 委托 dispatch（router.ts 调用形态）', async () => {
    const path = '/academy/training-task/TID';
    const r = await registerAcademyRoutes(new Request(`http://test${path}`), 'GET', path, deps);
    expect(r).not.toBeNull();
    expect(await r!.json()).toEqual({ handler: 'task' });
    expect(mocks.task).toHaveBeenCalledTimes(1);
  });
});
