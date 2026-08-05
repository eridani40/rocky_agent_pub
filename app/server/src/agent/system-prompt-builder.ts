/**
 * system_prompt builder —— mapper/reducer 双链 + 固定 join（v0.0.13 从 context-engine.ts 拆出）
 * 参考: specs/tech/agent/context/[P0]system_prompt.md §1/§3/§5
 *       specs/tech/agent/context/[P0]context_engine.md §3.5
 *
 * 设计：ContextEngine 不持 system_prompt 构建逻辑，本模块提供纯函数（pluginManager + config
 * → system string），便于单测 + 文件 ≤300 行拆分。
 *
 * 流程：
 *   ① mapper 链 concat PromptFragment[]（单 mapper 失败降级为「不贡献」system_prompt §9.4）
 *   ② reducer 链链式 reduce PromptFragment[] → PromptFragment[]
 *   ③ builder 固定 "\n\n".join（非扩展点，不可替换）
 *
 * [v0.0.64 P1] 硬失败设计：builder **永远走 mapper 链**，没有 "default system prompt" 概念。
 *   - 无 pluginManager → throw（rocky_context builtin 必须加载）
 *   - mapper 链空 → throw（附 registry 诊断信息）
 *   理由：静默 fallback DEFAULT 会让 mapper 链断裂（plugin 未加载/manifest 错）在 production
 *   难定位——LLM 拿到空 DEFAULT 行为退化、用户无感。硬失败把 misconfig 变成立即可见的 throw。
 *   silent degradation 难定位 = 教训。ContextEngine.assemble fallback path（pluginManager=null
 *   的 v0.0.8 测试兼容路径）不再调本函数，直接用 config.systemPrompt（详见 context-engine.ts）。
 */
import type { PluginManager } from '../plugin/plugin-manager';
import {
  SystemPromptMapperPoint,
  SystemPromptReducerPoint,
} from '../plugin/extension-point';
import type { SessionConfig } from './context-types';

/** PromptFragment（对齐 system_prompt.md §2） */
export type PromptFragment = {
  id: string;
  tier: string;
  content: string;
  priority?: number;
};

/** system_prompt_mapper 契约（system_prompt.md §3；允许 async impl） */
interface SystemPromptMapper {
  map(ctx: { config: SessionConfig }): PromptFragment[] | Promise<PromptFragment[]>;
}

/** system_prompt_reducer 契约（system_prompt.md §3） */
interface SystemPromptReducer {
  reduce(input: PromptFragment[], ctx: { config: SessionConfig }): PromptFragment[];
}

/**
 * 构建 system prompt string（context_engine.md §3.5 调 system_prompt 子系统）。
 *
 * [v0.0.64 P1] 硬失败契约：
 *   - pluginManager 为 null → throw（rocky_context builtin 必须加载）
 *   - mapper 链空 → throw（附 pluginManager.listPlugins 诊断信息）
 *
 * scope 解析：mapper/reducer 链按 scopeId 取 impl 列表（per-EP 回退：scope 未激活该 EP →
 *   沿 extends 链回退 default）。scope 级 system_prompt 覆写靠本参数生效；缺省 'default'。
 *
 * @param pluginManager PluginManager（跑链入口；不可为 null）
 * @param config session context（含 tools/workdir/cwd 等，各 mapper 按需读）
 * @param scopeId scope 标识（= SessionKind canonicalId；缺省 'default'）
 * @returns system prompt string
 * @throws Error pluginManager 缺失 或 mapper 链空（含诊断信息）
 */
export async function buildSystemPrompt(
  pluginManager: PluginManager | null,
  config: SessionConfig,
  scopeId: string = 'default',
): Promise<string> {
  if (!pluginManager) {
    throw new Error(
      'SystemPromptBuilder: pluginManager required — rocky_context builtin must load (no fallback)',
    );
  }
  const mappers = pluginManager.getExtensionImpls<SystemPromptMapper>(
    SystemPromptMapperPoint,
    scopeId,
  );
  if (mappers.length === 0) {
    // 附 registry 诊断信息：listPlugins 不在 PluginManager 公共 API（运行时探测，TS 不感知）
    //   能力探测避免假设完整 API 面（Bun/精简实现可能无此方法）
    const pmAny = pluginManager as unknown as { listPlugins?: () => string[] };
    const diagnostic = typeof pmAny.listPlugins === 'function'
      ? JSON.stringify(pmAny.listPlugins())
      : 'n/a (PluginManager.listPlugins not exposed)';
    throw new Error(
      `SystemPromptBuilder: system_prompt_mapper chain empty — registry plugins: ${diagnostic}`,
    );
  }
  const ctx = { config };
  // ① mapper 链：concat fragments（单 mapper 失败降级，system_prompt §9.4）
  //   async impl 必须 await——同步迭代 Promise 会抛 TypeError
  //   被降级 catch 吞掉，mapper 输出静默丢失
  let fragments: PromptFragment[] = [];
  for (const m of mappers) {
    try {
      const produced = await m.map(ctx);
      for (const f of produced) fragments.push(f);
    } catch {
      // 单 mapper 失败降级：跳过该 mapper，不贡献 fragments（system_prompt §9.4）
    }
  }
  // ② reducer 链：链式 reduce
  const reducers = pluginManager.getExtensionImpls<SystemPromptReducer>(
    SystemPromptReducerPoint,
    scopeId,
  );
  for (const r of reducers) {
    fragments = r.reduce(fragments, ctx);
  }
  // ③ builder 固定："\n\n".join（非扩展点，无脑拼接）
  return fragments.map((f) => f.content).filter(Boolean).join('\n\n');
}
