/**
 * observability-config 类型定义
 * 参考: specs/ui/components/app-dev-config-page/observability-config/_overview.md §2
 *
 * 可观测性后端实例配置（list-of-objects group），结构不同于普通 KV group。
 * 与 server ObservabilityConfigItem 同构；secretKey GET 返回明文，由前端 SecretInput 展示层 mask。
 */

/** 单个可观测性后端实例配置（UI 侧契约） */
export interface ObservabilityConfig {
  /** 实例 id，新增时前端生成 `obs_<ts>`，后端落库 */
  id: string;
  /** 配置名称，必填，如 "Production Tracing" */
  name: string;
  /** 类型，当前仅 langfuse（只读，预留扩展） */
  type: 'langfuse';
  /** 后端基地址，必填，如 https://cloud.langfuse.com */
  baseUrl: string;
  /** 公钥，必填（明文展示） */
  publicKey: string;
  /** 私钥，必填（仅本地存储；GET 返回明文，SecretInput 展示层自动 mask） */
  secretKey: string;
  /** 启停；toggle 独立即时生效，不计 dirty */
  enabled: boolean;
  /** 自由描述（列表行副标题片段） */
  desc: string;
  /**
   * [v0.0.50] 是否记录物理层 generation（protocol.encode 后 wire body，独立 generation 不带 usage）。
   * 默认 off（向后兼容 v0.0.49）；改动重启生效（manager bootstrap 时算好 per-child 标记，不热更新）。
   */
  logPhysical: boolean;
}

/** PUT 哨兵占位串（旧前端兼容：提交时若仍为此值，后端 merge 落盘原值；新前端提交明文不依赖此值） */
export const SECRET_REDACTED = '***';

/** 新增配置时构造的空壳（id 由调用方生成） */
export function emptyObservabilityDraft(id: string): ObservabilityConfig {
  return {
    id,
    name: '',
    type: 'langfuse',
    baseUrl: '',
    publicKey: '',
    secretKey: '',
    enabled: false,
    desc: '',
    // [v0.0.50] 物理层 generation 默认 off（向后兼容 v0.0.49，token/cost 统计不污染）
    logPhysical: false,
  };
}

/**
 * 生成新实例 id：`obs_<毫秒时间戳>`。
 * 同一毫秒内并发创建概率极低（UI 单用户顺序操作）；如需更强唯一性可加随机后缀。
 */
export function generateObsId(): string {
  return `obs_${Date.now()}`;
}

/**
 * 判定 detail 是否有未保存改动（dirty）。
 * [v0.0.317 D9] enabled 计入 dirty（detail toggle 不再即时生效，攒 draft 走 tab 级统一保存；
 *   list 级 toggle 仍即时——D10 范式 C list 级 = 即时，不经此函数）。
 */
export function isObservabilityDirty(draft: ObservabilityConfig, saved: ObservabilityConfig): boolean {
  const keys = Object.keys(draft) as (keyof ObservabilityConfig)[];
  for (const k of keys) {
    if (draft[k] !== saved[k]) return true;
  }
  return false;
}

/**
 * 必填字段校验（保存前）。
 * name / baseUrl / publicKey / secretKey 任一为空 → 不可保存。
 * secretKey 为非空字符串即视为有效（明文 GET 回来，编辑态直接持有原文）。
 */
export function isObservabilityValid(c: ObservabilityConfig): boolean {
  if (!c.name.trim()) return false;
  if (!c.baseUrl.trim()) return false;
  if (!c.publicKey.trim()) return false;
  if (!c.secretKey.trim()) return false;
  return true;
}
