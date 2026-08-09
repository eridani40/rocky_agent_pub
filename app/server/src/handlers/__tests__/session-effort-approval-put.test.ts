/**
 * [v0.0.148 链路 A+B] effort/approvalMode 透传链 UT
 *   - validateEffortApproval 非法 enum 返错误（caller 转 400）
 *   - PUT /session/:id handler 透传 effort/approvalMode（部分更新语义）
 *   - buildSessionConfigFromDeps 注入 config.effort（session.effort → config.effort）
 *
 * 参考: specs/tech/version_logs/v0.0.148/change_plan.md 链路 A（effort 透传）+ 链路 B（handler）
 *
 * 文件系统隔离：tmpdir + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { AppConfigService } from '../../config/app-config-service';
import { ulid } from '../../config/ulid';
import { bootstrapBuiltinPlugins } from '../../bootstrap';
import { buildSessionConfigFromDeps } from '../session-config';
import { buildRealSessionTypePolicy } from '../../agent/__helpers__/session-type-policy-test-helper';
import { handleSessionItem } from '../session';
import { validateEffortApproval } from '../session-deps';
import type { SessionHandlerDeps } from '../session';
import type { UpdateSessionBody } from '../session-deps';
import { SessionKind } from '@app/shared';

const PG_ROCKY_MAIN = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' });

let tmpRoot: string;
let store: SessionStore;
let appConfig: AppConfigService;
let deps: SessionHandlerDeps;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-effort-put-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  appConfig = new AppConfigService({ root: tmpRoot });
  const bs = await bootstrapBuiltinPlugins(tmpRoot);
  appConfig.set('providers', 'mock-prov', {
    id: 'mock-prov',
    name: 'mock',
    enabled: true,
    kind: 'mock',
    credential: {},
    models: [{ modelId: 'mock-model' }],
  });
  appConfig.set('default_models', 'default', { chat: 'mock-model', summary: 'mock-model' });
  deps = {
    store,
    agentManager: bs.agentManager,
    appConfig,
    pluginManager: bs.pluginManager,
    contextEngine: bs.contextEngine,
    dataDir: tmpRoot,
    sessionTypePolicy: buildRealSessionTypePolicy(tmpRoot),
  };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('validateEffortApproval — enum 校验（闭合 enum）', () => {
  it('合法 effort 4 档 → null（放行）', () => {
    for (const e of ['default', 'low', 'high', 'max'] as const) {
      expect(validateEffortApproval({ effort: e })).toBeNull();
    }
  });

  it('合法 approvalMode 2 档 → null（放行）', () => {
    for (const m of ['normal', 'greenlight'] as const) {
      expect(validateEffortApproval({ approvalMode: m })).toBeNull();
    }
  });

  it('非法 effort → 错误 string', () => {
    const err = validateEffortApproval({ effort: 'ultra' as UpdateSessionBody['effort'] });
    expect(err).not.toBeNull();
    expect(err).toContain('effort');
  });

  it('非法 approvalMode → 错误 string', () => {
    const err = validateEffortApproval({
      approvalMode: 'auto' as UpdateSessionBody['approvalMode'],
    });
    expect(err).not.toBeNull();
    expect(err).toContain('approvalMode');
  });

  it('都不传 → null（部分更新语义，不校验）', () => {
    expect(validateEffortApproval({})).toBeNull();
  });
});

describe('PUT /session/:id — effort/approvalMode 透传（部分更新）', () => {
  async function putSession(
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const res = await handleSessionItem(
      new Request(`http://x/session/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
      'PUT',
      id,
      deps,
    );
    return { status: res.status, body: await res.json() };
  }

  it('PUT effort=high → 持久化读回 high', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const { status, body } = await putSession(sid, { effort: 'high' });
    expect(status).toBe(200);
    expect((body as { effort?: string }).effort).toBe('high');
  });

  it('PUT approvalMode=greenlight → 持久化读回 greenlight', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const { status, body } = await putSession(sid, { approvalMode: 'greenlight' });
    expect(status).toBe(200);
    expect((body as { approvalMode?: string }).approvalMode).toBe('greenlight');
  });

  it('PUT 非法 effort → 400', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const { status } = await putSession(sid, { effort: 'turbo' });
    expect(status).toBe(400);
  });

  it('PUT 非法 approvalMode → 400', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const { status } = await putSession(sid, { approvalMode: 'yolo' });
    expect(status).toBe(400);
  });

  it('PUT 不传 effort → 保留 existing（部分更新语义）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid, effort: 'low' });
    // 改 title 不传 effort
    await putSession(sid, { title: '改名' });
    const got = await store.getSession(sid);
    expect(got!.effort).toBe('low');
  });

  it('PUT effort=default 显式切回默认档', async () => {
    const sid = ulid();
    await store.createSession({ id: sid, effort: 'max' });
    const { body } = await putSession(sid, { effort: 'default' });
    expect((body as { effort?: string }).effort).toBe('default');
  });
});

describe('buildSessionConfigFromDeps — effort 注入 config.effort（透传链源头）', () => {
  it('sessionPersist.effort=high → config.effort=high', () => {
    const config = buildSessionConfigFromDeps(
      deps,
      ulid(),
      { effort: 'high' },
      PG_ROCKY_MAIN,
    );
    expect(config.effort).toBe('high');
  });

  it('sessionPersist 不传 effort → config.effort undefined（encode 走 default 档）', () => {
    const config = buildSessionConfigFromDeps(deps, ulid(), {}, PG_ROCKY_MAIN);
    expect(config.effort).toBeUndefined();
  });

  it('sessionPersist.effort=default → config.effort undefined（default = 不覆盖，走厂商默认）', () => {
    const config = buildSessionConfigFromDeps(
      deps,
      ulid(),
      { effort: 'default' },
      PG_ROCKY_MAIN,
    );
    expect(config.effort).toBeUndefined();
  });

  it('sessionPersist.effort=max → config.effort=max', () => {
    const config = buildSessionConfigFromDeps(
      deps,
      ulid(),
      { effort: 'max' },
      PG_ROCKY_MAIN,
    );
    expect(config.effort).toBe('max');
  });
});

describe('buildSessionConfigFromDeps — [v0.0.148 链路 D] approvalMode 注入 config.approvalMode', () => {
  it('sessionPersist.approvalMode=greenlight → config.approvalMode=greenlight', () => {
    const config = buildSessionConfigFromDeps(
      deps,
      ulid(),
      { approvalMode: 'greenlight' },
      PG_ROCKY_MAIN,
    );
    expect(config.approvalMode).toBe('greenlight');
  });

  it('sessionPersist 不传 approvalMode → config.approvalMode undefined（engine 走 normal 分支）', () => {
    const config = buildSessionConfigFromDeps(deps, ulid(), {}, PG_ROCKY_MAIN);
    expect(config.approvalMode).toBeUndefined();
  });

  it('sessionPersist.approvalMode=normal → config.approvalMode=normal（显式 normal）', () => {
    const config = buildSessionConfigFromDeps(
      deps,
      ulid(),
      { approvalMode: 'normal' },
      PG_ROCKY_MAIN,
    );
    expect(config.approvalMode).toBe('normal');
  });

  it('effort + approvalMode 同时注入（两个字段独立透传）', () => {
    const config = buildSessionConfigFromDeps(
      deps,
      ulid(),
      { effort: 'high', approvalMode: 'greenlight' },
      PG_ROCKY_MAIN,
    );
    expect(config.effort).toBe('high');
    expect(config.approvalMode).toBe('greenlight');
  });
});
