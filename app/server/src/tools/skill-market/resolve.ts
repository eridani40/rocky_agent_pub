/**
 * skill 市场 provider 解析（exclusive EP resolve；tool action 与 HTTP handler 共用）
 * 参考: specs/tech/agent/skills/[P1]skill_market.md §5；change_plan v0.0.166 模块 ⑥
 *
 * skill_market_provider 是 exclusive 扩展点：同一时刻至多一个市场源生效（scope 配置
 * `selected: skills_sh` 决定），故 resolve 直接取 getExtensionImpls(SkillMarketProviderPoint)[0]
 * （≤1 active，无 active → provider undefined）——不做 web_search 那种按 type 精确路由。
 *
 * 凭证：app_config `skill_market` group 只存 credentials（无 type 字段，exclusive 靠 scope
 * selected 选源）。cfg = credentials[provider.id] ?? {}（不透明 map 透传给 provider）。
 */
import type { ExtensionPoint } from '../../plugin/extension-point';
import { SkillMarketProviderPoint } from '../../plugin/extension-point';
import type { ToolCtx } from '../types';
import type { SkillMarketCfg, SkillMarketProvider } from './types';

/** app_config.skill_market.default 的最小形状（只放 credentials，无 type） */
interface SkillMarketConfigData {
  credentials?: Record<string, Record<string, unknown>>;
}

/** AppConfigService 鸭子类型（仅需 get(group, key)） */
interface AppConfigLike {
  get(group: string, key: string): unknown;
}

/** PluginManager 鸭子类型（仅需 getExtensionImpls） */
interface PluginManagerLike {
  getExtensionImpls<T = unknown>(point: ExtensionPoint): T[];
}

/**
 * 从 ctx.config（appConfig + pluginManager）解析生效的 skill 市场 provider + 其 cfg。
 * exclusive EP：取 getExtensionImpls(SkillMarketProviderPoint)[0]（scope selected 已收窄到 ≤1）。
 * 无 pluginManager / 无 active impl → provider undefined（caller 报「未配置市场源」不回退）。
 *
 * @returns `{ provider?, cfg }`：provider = 生效市场源；cfg = credentials[provider.id] ?? {}
 */
export function resolveSkillMarketProvider(ctx: ToolCtx): {
  provider?: SkillMarketProvider;
  cfg: SkillMarketCfg;
} {
  // 1. 取 exclusive EP 的 active impl（scope selected 决定，≤1）
  const pm = ctx.config.pluginManager as PluginManagerLike | undefined;
  if (!pm || typeof pm.getExtensionImpls !== 'function') return { cfg: {} };
  const impls = pm.getExtensionImpls<SkillMarketProvider>(SkillMarketProviderPoint);
  const provider = impls[0];
  if (!provider) return { cfg: {} };

  // 2. cfg = app_config.skill_market.default.credentials[provider.id] ?? {}
  const appConfig = ctx.config.appConfig as AppConfigLike | undefined;
  if (!appConfig || typeof appConfig.get !== 'function') return { provider, cfg: {} };
  const data = appConfig.get('skill_market', 'default') as SkillMarketConfigData | undefined;
  return { provider, cfg: data?.credentials?.[provider.id] ?? {} };
}
