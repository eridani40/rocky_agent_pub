/**
 * squad-service 写入校验 UT（v0.0.36 fail-fast + v0.0.155 ModelRef 复合）
 * 参考: specs/api/overall/11a-squad-endpoints.md §1.1 §2.1
 *       specs/api/overall/02-llm-chat.md §5（provider/model enabled 语义）
 *       specs/tech/version_logs/v0.0.155/change_plan.md §B（ModelRef 复合 + INV-C1）
 *
 * 背景：handler 层已校验（返 400），本文件验证 service 层 defense-in-depth——直接调
 *   createSquadService 时，appConfig 注入则校验 modelDefault 合法性（非法抛清晰错误）；
 *   appConfig 省略退化为非空校验（向后兼容不回归）。
 *
 * [v0.0.155] member.model 已硬删（A4），原 member-service model 校验用例整体移除；
 *   新增 squad 复合 ModelRef（modelDefaultProviderId）校验用例（INV-B1/B2/C1）。
 *
 * 文件系统隔离：mkdtempSync + rmSync。单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { createSquadService, type SquadServiceDeps } from '../squad-service';
import { createMemberService } from '../member-service';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { AppConfigService } from '../../config/app-config-service';

let tmpRoot: string;
let sessionStore: SessionStore;
let squadStore: SquadStore;
let memberStore: MemberStore;
let appConfig: AppConfigService;
let deps: SquadServiceDeps;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-mv-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine).mount('transcript', fsEngine)
    .mount('summary', fsEngine).mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  squadStore = new SquadStore({ root: tmpRoot });
  memberStore = new MemberStore({ root: tmpRoot });
  appConfig = new AppConfigService({ root: tmpRoot });
  // 两 provider 同名 modelId：测复合 providerId 解歧义（INV-B2）
  appConfig.set('providers', 'prov-a', {
    id: 'prov-a', name: 'a', enabled: true, kind: 'mock', credential: {},
    models: [{ modelId: 'claude-sonnet-4', enabled: true }, { modelId: 'shared-model', enabled: true }],
  });
  appConfig.set('providers', 'prov-b', {
    id: 'prov-b', name: 'b', enabled: true, kind: 'mock', credential: {},
    models: [{ modelId: 'shared-model', enabled: true }],
  });
  deps = { sessionStore, squadStore, memberStore, dataDir: tmpRoot, appConfig };
});

afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

describe('[v0.0.36] createSquadService 写入校验（defense-in-depth）', () => {
  it('appConfig 注入 + modelDefault 非法 → 抛清晰错误', async () => {
    await expect(createSquadService(deps, {
      name: 's1', modelDefault: 'claude-sonnet', leader: { name: 'lead' },
    })).rejects.toThrow(/claude-sonnet 不是任何已启用 provider 的合法 modelId/);
  });

  it('appConfig 注入 + modelDefault 合法 → 建队成功（不回归）', async () => {
    const created = await createSquadService(deps, {
      name: 's1', modelDefault: 'claude-sonnet-4', leader: { name: 'lead' },
    });
    expect(created.squad.modelDefault).toBe('claude-sonnet-4');
  });

  it('appConfig 省略 + 非法 modelDefault → 不校验合法性（仅非空，向后兼容）', async () => {
    const noConfigDeps: SquadServiceDeps = { sessionStore, squadStore, memberStore, dataDir: tmpRoot };
    const created = await createSquadService(noConfigDeps, {
      name: 's1', modelDefault: 'claude-sonnet', leader: { name: 'lead' },
    });
    expect(created.squad.modelDefault).toBe('claude-sonnet');
  });
});

describe('[v0.0.155] createSquadService ModelRef 复合校验（INV-B1/B2/C1）', () => {
  it('modelDefault + providerId 复合精确命中（同名 model 跨 provider）→ 建队成功', async () => {
    // 'shared-model' 在 prov-a 和 prov-b 都有；hint=prov-b 精确匹配
    const created = await createSquadService(deps, {
      name: 's1',
      modelDefault: 'shared-model',
      modelDefaultProviderId: 'prov-b',
      leader: { name: 'lead' },
    });
    expect(created.squad.modelDefault).toBe('shared-model');
    expect(created.squad.modelDefaultProviderId).toBe('prov-b');
  });

  it('providerId 命中 provider 但 provider 不含该 modelId → 抛清晰错误（精确校验）', async () => {
    // prov-b 无 'claude-sonnet-4'，hint=prov-b → 精确失败
    await expect(createSquadService(deps, {
      name: 's1',
      modelDefault: 'claude-sonnet-4',
      modelDefaultProviderId: 'prov-b',
      leader: { name: 'lead' },
    })).rejects.toThrow(/claude-sonnet-4 不属于 provider prov-b/);
  });

  it('providerId 指向不存在的 provider → 抛清晰错误', async () => {
    await expect(createSquadService(deps, {
      name: 's1',
      modelDefault: 'claude-sonnet-4',
      modelDefaultProviderId: 'phantom-prov',
      leader: { name: 'lead' },
    })).rejects.toThrow(/providerId phantom-prov 未启用或不存在/);
  });

  it('无 providerId（旧 back-compat）→ 跨 provider 反查命中（INV-B3 救存量）', async () => {
    // 无 hint → 跨 provider 反查，listGroup 顺序命中 prov-a
    const created = await createSquadService(deps, {
      name: 's1',
      modelDefault: 'shared-model',
      leader: { name: 'lead' },
    });
    expect(created.squad.modelDefault).toBe('shared-model');
    expect(created.squad.modelDefaultProviderId).toBeUndefined();
  });

  // v0.0.158: squad.summaryModelDefault* 字段族整删（chat/compact 同链），原 summary 复合校验 UT 已随字段一并删除
});

describe('[v0.0.155] createMemberService 无 model 校验（A4 硬删 member.model）', () => {
  it('fresh hire 不再接受 model 字段（A4）；hire 成员无 model 字段', async () => {
    const created = await createSquadService(deps, {
      name: 's1', modelDefault: 'claude-sonnet-4', leader: { name: 'lead' },
    });
    const r = await createMemberService(deps, {
      squadId: created.squad.id, mode: 'fresh', name: 'm1', intro: 'i',
    });
    // member.model 已硬删；record 不再有此字段
    expect((r.member as unknown as { model?: string }).model).toBeUndefined();
  });
});
