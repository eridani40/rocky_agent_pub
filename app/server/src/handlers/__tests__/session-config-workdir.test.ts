/**
 * session-config helper — workdir 接线测试（v0.0.17 T1）
 * 参考: specs/tech/agent/session/[P0]session_workspace.md §1（workdir = session.workspaceDir）
 *
 * 覆盖：
 *   - workspaceDir 入参非空 → SessionConfig.workdir = workspaceDir（loop 启动用 session 真相源）
 *   - workspaceDir 入参空/缺省 → 回退 <DATA_DIR>/workspace（向后兼容）
 *
 * 真实 SessionStore + 真实 AppConfigService（bootstrap fixture，mock provider）+ tmpdir。
 * 文件系统隔离：不读写 ~/.oobt-desktop/ 等真实路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { AppConfigService } from '../../config/app-config-service';
import { ulid } from '../../config/ulid';
import { bootstrapBuiltinPlugins } from '../../bootstrap';
import { buildSessionConfigFromDeps } from '../session-config';
import { buildRealSessionTypePolicy } from '../../agent/__helpers__/session-type-policy-test-helper';
import type { SessionHandlerDeps } from '../session';
// [v0.0.56 hotfix] kind 必传——本文件全部用 playground/rocky/main（通用 workdir/scope 测试）
import { SessionKind } from '@app/shared';
const PG_ROCKY_MAIN = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' });

let tmpRoot: string;
let store: SessionStore;
let appConfig: AppConfigService;
let deps: SessionHandlerDeps;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-config-ws-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  appConfig = new AppConfigService({ root: tmpRoot });
  // bootstrap 出 pluginManager（mock provider 注册到 app_config）
  const bs = await bootstrapBuiltinPlugins(tmpRoot);
  // 写一个 mock provider 到 app_config（供 resolveModel 命中）
  appConfig.set('providers', 'mock-prov', {
    id: 'mock-prov',
    name: 'mock',
    enabled: true,
    kind: 'mock',
    credential: {},
    models: [{ modelId: 'mock-model' }],
  });
  // [v0.0.89 工作块 ③] resolveModel 不静默兜底「首个 enabled provider」（PRD §5.1）。
  //   本测试聚焦 workdir/scope，不验 model 解析；配 default_models.chat 让 resolve 链命中。
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

describe('buildSessionConfigFromDeps — [v0.0.17] workdir 接线', () => {
  it('workspaceDir 入参非空 → SessionConfig.workdir = workspaceDir', () => {
    const sid = ulid();
    const workspaceDir = resolve(tmpRoot, 'workspaces', sid);
    const config = buildSessionConfigFromDeps(
      deps,
      sid,
      {},
      PG_ROCKY_MAIN,
      workspaceDir,
    );
    // spec §1：loop 启动时 workdir = session.workspaceDir
    expect(config.workdir).toBe(workspaceDir);
    // 幂等 mkdir（spec §3 约束）
    expect(existsSync(workspaceDir)).toBe(true);
  });

  it('workspaceDir 入参为空串 → 回退 <DATA_DIR>/workspace（向后兼容）', () => {
    const sid = ulid();
    const config = buildSessionConfigFromDeps(
      deps,
      sid,
      {},
      PG_ROCKY_MAIN,
      '',
    );
    // 空串 → 回退默认 <DATA_DIR>/workspace
    expect(config.workdir).toBe(join(tmpRoot, 'workspace'));
  });

  it('workspaceDir 入参 undefined → 回退 <DATA_DIR>/workspace（向后兼容）', () => {
    const sid = ulid();
    const config = buildSessionConfigFromDeps(
      deps,
      sid,
      {},
      PG_ROCKY_MAIN,
      undefined,
    );
    expect(config.workdir).toBe(join(tmpRoot, 'workspace'));
  });

  it('workspaceDir 接线：tools 用 session.workspaceDir 作根（defaultTools(workdir)）', () => {
    const sid = ulid();
    const workspaceDir = resolve(tmpRoot, 'workspaces', sid);
    const config = buildSessionConfigFromDeps(
      deps,
      sid,
      {},
      PG_ROCKY_MAIN,
      workspaceDir,
    );
    // tools 由 defaultTools(workdir) 构造，workdir 即 session.workspaceDir
    expect(config.tools).toBeDefined();
    expect(Array.isArray(config.tools)).toBe(true);
    expect(config.tools!.length).toBeGreaterThan(0);
    expect(config.workdir).toBe(workspaceDir);
  });
});

describe('buildSessionConfigFromDeps — [v0.0.28] scope 接线（v0.0.204 T2-B2: SessionConfig.scope 字段已删；param 保留向后兼容，运行时被忽略）', () => {
  it("scope 入参='subagent' → 运行时被忽略（kind.isSubagent 才是真身），不 throw", () => {
    const sid = ulid();
    const config = buildSessionConfigFromDeps(
      deps,
      sid,
      {},
      PG_ROCKY_MAIN,
      resolve(tmpRoot, 'workspaces', sid),
      'subagent',
    );
    // v0.0.204 T2-B2: scope 字段已删；scope param 保留为向后兼容（运行时被忽略）
    expect(config.kind).toBeDefined();
  });

  it("scope 入参='session' → 运行时被忽略", () => {
    const sid = ulid();
    const config = buildSessionConfigFromDeps(
      deps,
      sid,
      {},
      PG_ROCKY_MAIN,
      resolve(tmpRoot, 'workspaces', sid),
      'session',
    );
    expect(config.kind).toBeDefined();
  });

  it('scope 入参缺省 → 不 throw（顶层 standalone / parent 默认）', () => {
    const sid = ulid();
    const config = buildSessionConfigFromDeps(
      deps,
      sid,
      {},
      PG_ROCKY_MAIN,
      resolve(tmpRoot, 'workspaces', sid),
    );
    expect(config.kind).toBeDefined();
  });
});
