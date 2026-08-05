/**
 * channel-api — 渠道配置页 HTTP facade 薄封装
 * 参考: specs/api/overall/17-channel.md（GET/POST/PUT/DELETE /config/channels）
 *
 * 复用 api-client.req<>() 封装风格（与 chat-api/connector-api 同款）。
 * appSecret 约定：GET 返明文 appSecret（前端 SecretInput mask 展示）；POST 明文；
 * PUT 前端直接传明文（原值或新值），后端 mergeChannelSecret 的 '***' sentinel 保留但前端不再使用。
 */

import { req } from './api-client';

/** channel connection 运行时态（4 态闭合，对齐 17-channel.md §2） */
export type ChannelConnection = 'disconnected' | 'connecting' | 'connected' | 'error';

/** channel config + 实时状态（GET /config/channels items 形状，17-channel.md §2） */
export interface ChannelConfig {
  id: string;
  implId: string;
  name: string;
  /** switch 持久化 intent（UI 展示层与 connector 对齐用 enabled） */
  enabled: boolean;
  config: { appId: string; appSecret: string };
  connection: ChannelConnection;
  /** connection='error' 时原因 */
  errorDetail?: string | null;
  /** 上次 connected 时间戳（ms） */
  lastConnectedAt?: number | null;
  /** 该 config 当前 binding 数 */
  bindingCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** 渠道 impl 类型（GET /config/channels/impl-types items 形状；label 为原始 `__MSG_` 占位符，渲染期由页面 resolveI18nField 解析） */
export interface ChannelImplTypeInfo {
  implId: string;
  label: string;
}

/** 新建表单输入（UI → POST/PUT） */
export interface ChannelFormInput {
  implId: string;
  name: string;
  appId: string;
  /** 新建=明文；编辑=原明文（未改）或新值（前端直接传明文，不再使用 '***' sentinel） */
  appSecret: string;
}

/** GET /config/channels — 列全部 config + 实时状态（17-channel.md §2） */
export async function listChannels(base?: string): Promise<ChannelConfig[]> {
  const r = await req<{ items: ChannelConfig[] }>('/config/channels', undefined, base);
  return r.items ?? [];
}

/**
 * GET /config/channels/impl-types — 列 scope 激活的渠道 impl 类型（17-channel.md）
 * label 为原始 `__MSG_` 占位符——MUST NOT 在 lib 层解析 i18n，由页面渲染期 resolveI18nField 处理。
 */
export async function listChannelImplTypes(base?: string): Promise<ChannelImplTypeInfo[]> {
  const r = await req<{ items: ChannelImplTypeInfo[] }>('/config/channels/impl-types', undefined, base);
  return r.items ?? [];
}

/** POST /config/channels — 新建 config（17-channel.md §3，enabled 默认 true 建完即连） */
export async function createChannel(input: ChannelFormInput, base?: string): Promise<ChannelConfig> {
  return req<ChannelConfig>('/config/channels', {
    method: 'POST',
    body: JSON.stringify({
      implId: input.implId,
      name: input.name,
      config: { appId: input.appId, appSecret: input.appSecret },
      enabled: true,
    }),
  }, base);
}

/** PUT /config/channels/:id — 改 config（17-channel.md §4，appSecret '***'=未改） */
export async function updateChannel(
  id: string,
  patch: { name?: string; appId?: string; appSecret?: string; enabled?: boolean },
  base?: string,
): Promise<{ ok: true }> {
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.appId !== undefined || patch.appSecret !== undefined) {
    body.config = {
      ...(patch.appId !== undefined ? { appId: patch.appId } : {}),
      ...(patch.appSecret !== undefined ? { appSecret: patch.appSecret } : {}),
    };
  }
  if (patch.enabled !== undefined) body.enabled = patch.enabled;
  return req<{ ok: true }>(`/config/channels/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, base);
}

/** DELETE /config/channels/:id — 删 config（17-channel.md §5，disconnect+清 binding+清订阅+落盘删） */
export async function deleteChannel(id: string, base?: string): Promise<{ ok: true }> {
  return req<{ ok: true }>(`/config/channels/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }, base);
}
