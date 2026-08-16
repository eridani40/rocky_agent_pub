/**
 * model-routing-validation 单测（v0.0.347 T1）—— validateModelRoutingPlan 全规则
 * 参考: specs/api/overall/21-model-routing.md §2.2（校验表 + message 契约）
 *       specs/prd/model-routing-PRD-2026-08-14.md §2.8（UC-21/22/23 同模型约束）
 *
 * 覆盖（change_plan tests 行 + task.json acceptanceCriteria）：
 *   - 合法通过（含 enabled 缺省 true 兼容）
 *   - name/items 缺失 / items 非数组 / 空
 *   - provider 不存在 / model disabled / provider disabled
 *   - priority 非正整数 / 重复
 *   - 同模型 2 带时间拒绝（UC-22）/ 2 不带时间拒绝（UC-23）/ 带时间在下拒绝（UC-21）
 *   - timeCondition.hours 白名单（0-23 整数 / 去重）
 *   - 停用条目不占同模型额度（enabled=false 跳过约束）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../config/app-config-service';
import {
  validateModelRoutingPlan,
  isItemEnabled,
  isItemTimeConditioned,
  isValidTimezone,
  type ModelRoutingPlan,
} from '../model-routing-validation';

let tmpRoot: string;
let appConfig: AppConfigService;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mr-val-'));
  appConfig = new AppConfigService({ root: tmpRoot });
  // 两个 enabled provider：prov-a（model-a + disabled-model）+ prov-b（model-b）
  appConfig.set('providers', 'prov-a', {
    id: 'prov-a', name: 'a', enabled: true, kind: 'mock', credential: {},
    models: [
      { modelId: 'model-a', enabled: true },
      { modelId: 'disabled-model', enabled: false },
    ],
  });
  appConfig.set('providers', 'prov-b', {
    id: 'prov-b', name: 'b', enabled: true, kind: 'mock', credential: {},
    models: [{ modelId: 'model-b', enabled: true }],
  });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造合法方案（2 条目：a 带时间 + b 无条件） */
function validPlan(overrides?: Partial<ModelRoutingPlan>): ModelRoutingPlan {
  return {
    id: 'plan-1',
    name: '主力+兜底',
    items: [
      { providerId: 'prov-a', modelId: 'model-a', priority: 1, timeCondition: { hours: [2, 3, 4] }, enabled: true },
      { providerId: 'prov-b', modelId: 'model-b', priority: 2, enabled: true },
    ],
    createdAt: 1755200000000,
    ...overrides,
  };
}

describe('[v0.0.347] validateModelRoutingPlan — 基础结构', () => {
  it('合法方案 → ok', () => {
    expect(validateModelRoutingPlan(validPlan(), appConfig)).toEqual({ ok: true });
  });

  it('name 空 / 缺失 → 400 message', () => {
    expect(validateModelRoutingPlan(validPlan({ name: '' }), appConfig)).toEqual({
      ok: false, error: 'invalid model routing plan: name/items required',
    });
    const { name: _n, ...noName } = validPlan();
    void _n;
    expect(validateModelRoutingPlan(noName, appConfig).ok).toBe(false);
  });

  it('items 非数组 / 空数组 → 400 message', () => {
    expect(validateModelRoutingPlan(validPlan({ items: [] as never }), appConfig)).toEqual({
      ok: false, error: 'invalid model routing plan: name/items required',
    });
    expect(validateModelRoutingPlan({ ...validPlan(), items: 'x' as never }, appConfig)).toEqual({
      ok: false, error: 'invalid model routing plan: name/items required',
    });
  });

  it('id 缺失 → 400 message', () => {
    const { id: _id, ...noId } = validPlan();
    void _id;
    expect(validateModelRoutingPlan(noId, appConfig).ok).toBe(false);
  });

  it('非对象入参（null/undefined/标量）→ 400 message', () => {
    expect(validateModelRoutingPlan(null, appConfig)).toEqual({
      ok: false, error: 'invalid model routing plan: name/items required',
    });
    expect(validateModelRoutingPlan(undefined, appConfig)).toEqual({
      ok: false, error: 'invalid model routing plan: name/items required',
    });
    expect(validateModelRoutingPlan('x', appConfig).ok).toBe(false);
  });
});

describe('[v0.0.347] validateModelRoutingPlan — 模型指向校验（复用 model-validation）', () => {
  it('provider 不存在 → 400 message（model not found or disabled）', () => {
    const p = validPlan();
    p.items[0] = { ...p.items[0]!, providerId: 'prov-nope' };
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({
      ok: false, error: 'model routing plan item: model not found or disabled: prov-nope/model-a',
    });
  });

  it('model disabled → 400 message', () => {
    const p = validPlan();
    p.items[0] = { ...p.items[0]!, modelId: 'disabled-model' };
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({
      ok: false, error: 'model routing plan item: model not found or disabled: prov-a/disabled-model',
    });
  });

  it('provider disabled → 其 model 非法', () => {
    appConfig.set('providers', 'prov-c', {
      id: 'prov-c', name: 'c', enabled: false, kind: 'mock', credential: {},
      models: [{ modelId: 'c-model', enabled: true }],
    });
    const p = validPlan();
    p.items[1] = { ...p.items[1]!, providerId: 'prov-c', modelId: 'c-model' };
    expect(validateModelRoutingPlan(p, appConfig).ok).toBe(false);
  });

  it('model 不属于指定 provider（跨 provider 同名不命中）→ 400 message', () => {
    const p = validPlan();
    // model-b 属于 prov-b；hint 指向 prov-a → 不命中
    p.items[1] = { ...p.items[1]!, providerId: 'prov-a', modelId: 'model-b' };
    expect(validateModelRoutingPlan(p, appConfig).ok).toBe(false);
  });

  it('条目缺 providerId/modelId → 400 message', () => {
    const p = validPlan();
    p.items[0] = { ...p.items[0]!, providerId: '' };
    expect(validateModelRoutingPlan(p, appConfig).ok).toBe(false);
  });

  it('保留字 modelId default → 400 message（review Major-1）', () => {
    const p = validPlan();
    p.items[0] = { ...p.items[0]!, modelId: 'default' };
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({
      ok: false, error: 'model routing plan item: model not found or disabled: prov-a/default',
    });
  });

  it('保留字 modelId none → 400 message（review Major-1）', () => {
    const p = validPlan();
    p.items[0] = { ...p.items[0]!, modelId: 'none' };
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({
      ok: false, error: 'model routing plan item: model not found or disabled: prov-a/none',
    });
  });
});

describe('[v0.0.347] validateModelRoutingPlan — priority 规则', () => {
  it('priority 非正整数（0 / 负数 / 非整数）→ 400 message', () => {
    const p = validPlan();
    p.items[0] = { ...p.items[0]!, priority: 0 };
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({
      ok: false, error: 'invalid priority: must be positive unique integers',
    });
    p.items[0] = { ...p.items[0]!, priority: -1 };
    expect(validateModelRoutingPlan(p, appConfig).ok).toBe(false);
    p.items[0] = { ...p.items[0]!, priority: 1.5 };
    expect(validateModelRoutingPlan(p, appConfig).ok).toBe(false);
  });

  it('priority 重复 → 400 message', () => {
    const p = validPlan();
    p.items[1] = { ...p.items[1]!, priority: 1 };
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({
      ok: false, error: 'invalid priority: must be positive unique integers',
    });
  });
});

describe('[v0.0.347] validateModelRoutingPlan — 同模型约束（UC-21/22/23）', () => {
  it('同模型 2 带时间条目 → 拒绝（UC-22）', () => {
    const p = validPlan();
    // prov-a/model-a 两条都带时间
    p.items = [
      { providerId: 'prov-a', modelId: 'model-a', priority: 1, timeCondition: { hours: [2, 3] }, enabled: true },
      { providerId: 'prov-a', modelId: 'model-a', priority: 2, timeCondition: { hours: [4, 5] }, enabled: true },
    ];
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({
      ok: false, error: 'same model cannot have 2 time-condition items: prov-a/model-a',
    });
  });

  it('同模型 2 不带时间条目 → 拒绝（UC-23）', () => {
    const p = validPlan();
    p.items = [
      { providerId: 'prov-a', modelId: 'model-a', priority: 1, enabled: true },
      { providerId: 'prov-a', modelId: 'model-a', priority: 2, enabled: true },
    ];
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({
      ok: false, error: 'same model cannot have 2 unconditional items: prov-a/model-a',
    });
  });

  it('同模型带时间条目排在无条件条目下面 → 拒绝（UC-21）', () => {
    const p = validPlan();
    // 无条件 priority 1（上），带时间 priority 2（下）
    p.items = [
      { providerId: 'prov-a', modelId: 'model-a', priority: 1, enabled: true },
      { providerId: 'prov-a', modelId: 'model-a', priority: 2, timeCondition: { hours: [2, 3] }, enabled: true },
    ];
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({
      ok: false, error: 'time-condition item must be above unconditional item: prov-a/model-a',
    });
  });

  it('同模型 1 带时间 + 1 无条件且带时间在上 → 合法', () => {
    const p = validPlan();
    p.items = [
      { providerId: 'prov-a', modelId: 'model-a', priority: 1, timeCondition: { hours: [2, 3] }, enabled: true },
      { providerId: 'prov-a', modelId: 'model-a', priority: 2, enabled: true },
    ];
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({ ok: true });
  });

  it('停用条目不占同模型额度（enabled=false 跳过约束）', () => {
    const p = validPlan();
    // 同模型 3 条：2 停用 + 1 启用 → 合法
    p.items = [
      { providerId: 'prov-a', modelId: 'model-a', priority: 1, enabled: true },
      { providerId: 'prov-a', modelId: 'model-a', priority: 2, enabled: false },
      { providerId: 'prov-a', modelId: 'model-a', priority: 3, enabled: false },
    ];
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({ ok: true });
  });

  it('停用条目不影响带时间排序约束', () => {
    const p = validPlan();
    // 带时间 priority 2（下）+ 无条件 priority 1（上），但带时间条目停用 → 合法
    p.items = [
      { providerId: 'prov-a', modelId: 'model-a', priority: 1, enabled: true },
      { providerId: 'prov-a', modelId: 'model-a', priority: 2, timeCondition: { hours: [2, 3] }, enabled: false },
    ];
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({ ok: true });
  });
});

describe('[v0.0.347] validateModelRoutingPlan — timeCondition 白名单 + enabled 兼容', () => {
  it('hours 非 0-23 整数 → 400 message', () => {
    const p = validPlan();
    p.items[0] = { ...p.items[0]!, timeCondition: { hours: [2, 24] } };
    expect(validateModelRoutingPlan(p, appConfig).ok).toBe(false);
    p.items[0] = { ...p.items[0]!, timeCondition: { hours: [2, -1] } };
    expect(validateModelRoutingPlan(p, appConfig).ok).toBe(false);
    p.items[0] = { ...p.items[0]!, timeCondition: { hours: [2, 2.5] } };
    expect(validateModelRoutingPlan(p, appConfig).ok).toBe(false);
    p.items[0] = { ...p.items[0]!, timeCondition: { hours: [2, 3, 3] } };
    expect(validateModelRoutingPlan(p, appConfig).ok).toBe(false);
  });

  it('hours 空数组 = 全天等价无条件（不触发同模型 2 无条件拒绝的带时间判定）', () => {
    const p = validPlan();
    // 第一条 hours:[]（等价无条件）+ 第二条无条件 → 同模型 2 无条件 → 拒绝
    p.items = [
      { providerId: 'prov-a', modelId: 'model-a', priority: 1, timeCondition: { hours: [] }, enabled: true },
      { providerId: 'prov-a', modelId: 'model-a', priority: 2, enabled: true },
    ];
    expect(validateModelRoutingPlan(p, appConfig).ok).toBe(false);
  });

  it('enabled 缺省 true 兼容（旧 client 无 enabled 字段 = 启用）', () => {
    const p = validPlan();
    p.items = p.items.map((it) => {
      const { enabled: _e, ...rest } = it;
      void _e;
      return rest as typeof it;
    });
    // 无 enabled 字段 → 全部视为启用 → 同模型约束生效（校验通过）
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({ ok: true });
    // 辅助函数语义
    expect(isItemEnabled({})).toBe(true);
    expect(isItemEnabled({ enabled: false })).toBe(false);
    expect(isItemTimeConditioned({ providerId: 'p', modelId: 'm', priority: 1, timeCondition: { hours: [1] }, enabled: true })).toBe(true);
    expect(isItemTimeConditioned({ providerId: 'p', modelId: 'm', priority: 1, timeCondition: { hours: [] }, enabled: true })).toBe(false);
    expect(isItemTimeConditioned({ providerId: 'p', modelId: 'm', priority: 1, enabled: true })).toBe(false);
  });
});

describe('[v0.0.347 T5] circuit 参数校验（决策㉔：windowSize + minRequests ≤ windowSize）', () => {
  it('合法 circuit（windowSize 缺省 / 显式整数）→ ok', () => {
    expect(validateModelRoutingPlan(validPlan({ circuit: { windowSize: 20 } }), appConfig)).toEqual({ ok: true });
    expect(validateModelRoutingPlan(validPlan({ circuit: { windowSize: 1, minRequests: 1 } }), appConfig)).toEqual({ ok: true });
    expect(validateModelRoutingPlan(validPlan({ circuit: { windowSize: 1000 } }), appConfig)).toEqual({ ok: true });
  });

  it('windowSize 非整数 / <1 / >1000 → 400 message', () => {
    expect(validateModelRoutingPlan(validPlan({ circuit: { windowSize: 1.5 } }), appConfig)).toEqual({
      ok: false, error: 'invalid circuit: windowSize must be an integer in 1-1000',
    });
    expect(validateModelRoutingPlan(validPlan({ circuit: { windowSize: 0 } }), appConfig)).toEqual({
      ok: false, error: 'invalid circuit: windowSize must be an integer in 1-1000',
    });
    expect(validateModelRoutingPlan(validPlan({ circuit: { windowSize: -5 } }), appConfig)).toEqual({
      ok: false, error: 'invalid circuit: windowSize must be an integer in 1-1000',
    });
    expect(validateModelRoutingPlan(validPlan({ circuit: { windowSize: 1001 } }), appConfig)).toEqual({
      ok: false, error: 'invalid circuit: windowSize must be an integer in 1-1000',
    });
  });

  it('生效值 minRequests > windowSize → 400 message（病态配置：窗口永不满）', () => {
    // 显式两者都越界
    expect(validateModelRoutingPlan(validPlan({ circuit: { windowSize: 10, minRequests: 11 } }), appConfig)).toEqual({
      ok: false, error: 'invalid circuit: minRequests(11) must be <= windowSize(10)',
    });
    // minRequests 缺省 10 > windowSize 显式 5 → 越界（生效值比较）
    expect(validateModelRoutingPlan(validPlan({ circuit: { windowSize: 5 } }), appConfig)).toEqual({
      ok: false, error: 'invalid circuit: minRequests(10) must be <= windowSize(5)',
    });
    // windowSize 缺省 20 ≥ minRequests 显式 30 → 越界（生效值比较）
    expect(validateModelRoutingPlan(validPlan({ circuit: { minRequests: 30 } }), appConfig)).toEqual({
      ok: false, error: 'invalid circuit: minRequests(30) must be <= windowSize(20)',
    });
    // 边界相等合法
    expect(validateModelRoutingPlan(validPlan({ circuit: { windowSize: 10, minRequests: 10 } }), appConfig)).toEqual({ ok: true });
  });
});

describe('[v0.0.353 T1] timeCondition timezone 校验（D1）', () => {
  it('合法 IANA timezone → ok（Asia/Shanghai / UTC / America/New_York）', () => {
    const p = validPlan();
    p.items[0] = { ...p.items[0]!, timeCondition: { hours: [2, 3, 4], timezone: 'Asia/Shanghai' } };
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({ ok: true });
    p.items[0] = { ...p.items[0]!, timeCondition: { hours: [2, 3, 4], timezone: 'UTC' } };
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({ ok: true });
    p.items[0] = { ...p.items[0]!, timeCondition: { hours: [2, 3, 4], timezone: 'America/New_York' } };
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({ ok: true });
  });

  it('非法 timezone → 硬拒 400（error 含 timezone 关键字；不静默回退缺省时区）', () => {
    const p = validPlan();
    p.items[0] = { ...p.items[0]!, timeCondition: { hours: [2, 3, 4], timezone: 'Not/A_Timezone' } };
    const r = validateModelRoutingPlan(p, appConfig);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('timezone');
    p.items[0] = { ...p.items[0]!, timeCondition: { hours: [2, 3, 4], timezone: 'GMT+8' as unknown as string } };
    expect(validateModelRoutingPlan(p, appConfig).ok).toBe(false);
    p.items[0] = { ...p.items[0]!, timeCondition: { hours: [2, 3, 4], timezone: '' } };
    expect(validateModelRoutingPlan(p, appConfig).ok).toBe(false);
  });

  it('旧方案无 timezone → 兼容通过（缺省 Asia/Shanghai 语义，零突变）', () => {
    const p = validPlan(); // 第一条 timeCondition 仅 hours，无 timezone
    expect(validateModelRoutingPlan(p, appConfig)).toEqual({ ok: true });
  });

  it('isValidTimezone 辅助：IANA 合法/非法', () => {
    expect(isValidTimezone('Asia/Shanghai')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});
