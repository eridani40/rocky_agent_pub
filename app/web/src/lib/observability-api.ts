/**
 * observability-api — 可观测性配置端点封装
 * 参考: specs/api/overall/（/config/app group=runtime key=observability）
 *       specs/tech/config/[P0]app_config.md（v0.0.89 迁自 dev_config）
 *
 * v0.0.89 变更：dev_config 废弃，observability 数据迁入 app_config（同 group=runtime/key=observability）。
 *   GET/PUT 路径前缀 /config/dev → /config/app。
 *
 * 后端特化（与普通 KV group 不同）：
 *   GET  /config/app?group=runtime&key=observability → { value: ObservabilityConfigItem[] | null }
 *     （secretKey 明文返回，前端 SecretInput 展示层自动 mask；v0.0.119.bugs2 去脱敏）
 *   PUT  /config/app body { group:'runtime', key:'observability', data: ObservabilityConfigItem[] }
 *     （items 内 secretKey==='***' 后端自动 merge 落盘原值，旧前端兼容哨兵）
 *
 * 复用 api-client.req 的错误处理约定（抛 Error）。
 */
import { resolveApiBase } from './api-base';
import type { ObservabilityConfig } from '../components/app-dev-config-page/observability-config/types';

/** 内部 fetch 封装：复用 api-client.req 同款错误转异常逻辑 */
async function req<T>(path: string, init?: RequestInit, base?: string): Promise<T> {
  const res = await fetch(`${resolveApiBase(base)}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg = typeof body === 'object' && body && 'error' in body
      ? String((body as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

/**
 * GET /config/app?group=runtime&key=observability → ObservabilityConfig[]
 * 后端返回 value 可能为 null（首次无配置），统一转为空数组。
 *
 * [v0.0.50] 兼容老数据：logPhysical 字段是 v0.0.50 新增，老配置项可能缺省；
 * 此处把 undefined/null 归一为 false（默认关闭，向后兼容 v0.0.49 行为）。
 */
export async function getObservabilityConfigs(base?: string): Promise<ObservabilityConfig[]> {
  const r = await req<{ value: ObservabilityConfig[] | null }>(
    '/config/app?group=runtime&key=observability',
    undefined,
    base,
  );
  const list = r.value ?? [];
  return list.map((c) => ({ ...c, logPhysical: c.logPhysical === true }));
}

/**
 * PUT /config/app —— 整列表提交 observability 配置。
 * items 内 secretKey 明文提交（编辑态清空重输后得到新值）；若为 '***'（旧兼容哨兵），后端 merge 落盘原值。
 */
export async function putObservabilityConfigs(
  configs: ObservabilityConfig[],
  base?: string,
): Promise<void> {
  await req<{ ok: true }>('/config/app', {
    method: 'PUT',
    body: JSON.stringify({
      group: 'runtime',
      key: 'observability',
      data: configs,
    }),
  }, base);
}
