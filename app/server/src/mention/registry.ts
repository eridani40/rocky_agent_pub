/**
 * MentionProviderRegistry —— server-side 轻量 Registry
 * 参考: specs/tech/mention/provider-interface.md §4
 *
 * 按 name 注册 provider，search 时路由到对应 provider。
 * 不走 plugin EP（理由见 specs/tech/mention/index.md §⑤ 决策记录）。
 * bootstrap 阶段注册内置 provider（FileProvider + SkillProvider）。
 *
 * 设计：与 plugin/registry.ts 同模式（Map 索引 + 重复检测），但更轻量——
 * 仅需 register/get/search/listProviders 四个方法，无需 EP/manifest 概念。
 */
import type { MentionProvider, SearchCtx, SearchResult } from './types';

/**
 * mention provider 注册表。
 * register 注册 provider（name 唯一）；get 按 name 取 provider；
 * search 按 name 路由搜索；listProviders 返回所有已注册 provider 摘要。
 */
export class MentionProviderRegistry {
  private readonly providers = new Map<string, MentionProvider>();

  /**
   * 注册一个 provider（name 不可重复）。
   * @param provider 要注册的 provider 实例
   * @throws 同名 provider 已注册时抛错
   */
  register(provider: MentionProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(
        `MentionProviderRegistry: provider "${provider.name}" 已注册，不可重复注册`,
      );
    }
    this.providers.set(provider.name, provider);
  }

  /**
   * 按 name 取 provider（未注册返回 undefined）。
   * @param name provider 唯一标识
   */
  get(name: string): MentionProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * 按 provider name 路由搜索（未注册 → 抛错，handler 层转 404）。
   * @param providerName provider 唯一标识
   * @param ctx 搜索上下文
   * @throws provider 未注册时抛错
   */
  async search(providerName: string, ctx: SearchCtx): Promise<SearchResult> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(
        `MentionProviderRegistry: provider "${providerName}" 未注册`,
      );
    }
    return provider.search(ctx);
  }

  /**
   * 列出所有已注册 provider 的 name + label（前端 tab 列表用）。
   * @returns provider 摘要数组
   */
  listProviders(): Array<{ name: string; label: string }> {
    return [...this.providers.values()].map((p) => ({
      name: p.name,
      label: p.label,
    }));
  }
}
