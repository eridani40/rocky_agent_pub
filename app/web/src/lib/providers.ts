/**
 * providers —— provider/model 列表实时读取 + 显示名解析
 * 参考: specs/api/overall/02-llm-chat.md §5（GET /provider → {items:ProviderInstance[]}）
 *       specs/ui/overall/02-llm-chat.md §3.3（ModelPicker）
 *
 * 用途：
 *   - model-tag / ModelPicker 显示「provider label + model 显示名」而非裸 providerId/modelId（ULID）。
 *   - ModelPicker 与 chat 统一装配层（section-chat-session）共享同一份 providers 拉取 + 解析逻辑。
 *
 * v0.0.36 实时化（去永久缓存）：
 *   - 历史实现有 module 级永久缓存 cachedProviders，fetchProviders 命中即 return，开机首拉后
 *     永不刷新 —— 用户在配置中心新增/改动 provider/model，选择器里永远看不到（除非整页刷新）。
 *   - 现改为：fetchProviders 每次实时 GET /provider 拿最新列表，useProviders 每次组件挂载实时拉。
 *   - 仅保留 inFlight「同一瞬间并发去重」（多个组件同时挂载合并为一次请求），请求 settle 后立即
 *     清空 inFlight —— 绝不把结果钉成跨时间的永久缓存供后续复用。
 */
import { useEffect, useState } from 'react';
import { resolveApiBase } from './api-base';

/** GET /provider 响应里的 provider 项最小形态（spec §5.2） */
export interface ProviderItem {
  id: string;
  label: string;
  /**
   * [v0.0.350] provider 类型（ProviderName union；可选——旧响应缺省视为通用 anthropic_compatible）。
   * 额度总览过滤（isNativeCodingPlan）与类型显示用。
   */
  name?: string;
  /**
   * provider 启停（透传后端 GET /provider 已带的 enabled 字段）。
   * 可选 —— 运行时缺字段视为 enabled（对齐后端 `enabled !== false` 语义）。
   * 下游 picker / findProviderIdByModelId 据此过滤 disabled provider。
   */
  enabled?: boolean;
  models: {
    modelId: string;
    label?: string;
    /** model 启停（透传；缺字段视为 enabled，同 provider.enabled 语义） */
    enabled?: boolean;
  }[];
}

/** 选中项表达（POST /chat / PUT /session 入参） */
export interface ModelSelection {
  providerId: string;
  modelId: string;
}

/**
 * ModelRef string `"providerId/modelId"` → {@link ModelSelection} 拆解。
 * 空串/undefined/不合规（缺 / 或一侧空）→ null（语义：inherit/未配）。
 *
 * 用于把带斜杠的 ModelRef string 喂给 ModelPicker / InputModelPicker（后者接收
 * ModelSelection | null）。纯函数，无副作用。
 *
 * 注意：对纯 modelId（不含斜杠）恒返 null——此场景应改用 {@link findProviderIdByModelId}
 * 反查 provider（member.model / squad.modelDefault 均为纯 modelId 存储）。
 */
export function parseModelRef(model: string | undefined | null): ModelSelection | null {
  if (!model) return null;
  const idx = model.indexOf('/');
  if (idx <= 0 || idx >= model.length - 1) return null;
  return { providerId: model.slice(0, idx), modelId: model.slice(idx + 1) };
}

/**
 * 跨 providers 反查 modelId → providerId。
 *
 * 用于读侧把**纯 modelId**（member.model / squad.modelDefault 等持久化字段——
 * 参考 `[P0]model_resolve.md §4 原则 3`：ModelRef=纯 modelId string，不含 providerId 拼接）
 * 还原成 {@link ModelSelection} 喂给 picker：命中返 `{providerId, modelId}`，不命中/null 返 null
 * （picker 收 null 显「未配置」/走 defaultModelId 态）。
 *
 * 反查时跳过 disabled provider（`enabled === false`）——防止「默认项」
 * 指向停用 provider 的模型（发消息却 400）。对齐样板 KeyModelPicker + 后端
 * `findProviderForModel` 走 `listEnabledProviders` 的过滤语义。
 *
 * 纯函数，无副作用；与 `formatModelDisplay` 内 inline 回找逻辑同款。
 */
export function findProviderIdByModelId(
  providers: { id: string; enabled?: boolean; models: { modelId: string }[] }[],
  modelId: string,
): string | null {
  for (const p of providers) {
    // 停用 provider 的 model 不作为默认项反查命中（严格 false；undefined/true 通过）
    if (p.enabled === false) continue;
    if (p.models.some((m) => m.modelId === modelId)) return p.id;
  }
  return null;
}

/**
 * 并发去重句柄：仅在「同一瞬间」有多处同时调用时合并为一次网络请求。
 * 请求 settle（成功或失败）后立即清空 —— 不跨时间缓存结果，下次调用必发新请求。
 */
let inFlight: Promise<ProviderItem[]> | null = null;

/**
 * 测试桩（仅单测注入，生产代码恒为 null）。
 * 非 null 时 fetchProviders 直接返回它、绕过真实 fetch —— 这是测试 seam，不是运行时缓存。
 */
let testProviders: ProviderItem[] | null = null;

/**
 * GET /provider → ProviderItem[]，每次实时拉取最新列表（不跨时间缓存）。
 * - 同一瞬间多处并发调用 → 共享 inFlight 单次请求（settle 后清空）。
 * - 失败抛错（!res.ok）。
 * @returns 最新 provider 列表（无 items 时空数组）
 */
export async function fetchProviders(): Promise<ProviderItem[]> {
  // 测试桩：直接返回注入数据（不 fetch、不缓存）。生产恒 null，不走此分支。
  if (testProviders) return testProviders;
  // 并发去重：在途请求未 settle 时复用同一 promise，避免同瞬间多组件挂载打多次请求。
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const res = await fetch(`${resolveApiBase()}/provider`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`GET /provider failed: ${res.status}`);
    const data = (await res.json()) as { items?: ProviderItem[] };
    return data.items ?? [];
  })();
  try {
    return await inFlight;
  } finally {
    // 关键：settle 后清空 inFlight，绝不把结果钉成永久缓存。下次调用重新发请求。
    inFlight = null;
  }
}

/** 测试用：注入桩 providers（jsdom 单测，使 fetchProviders 返回此数据、绕过真实 fetch）。生产代码绝不调用。 */
export function __setProvidersCacheForTest(list: ProviderItem[]): void {
  testProviders = list;
}

/** 测试用：清空测试桩 + 在途请求（避免跨用例污染） */
export function __resetProvidersCacheForTest(): void {
  testProviders = null;
  inFlight = null;
}

/**
 * React hook：每次组件挂载实时拉最新 providers（异步），返回 {providers, error, loaded}。
 * - 每次 mount 触发一次 fetchProviders（实时），配合 inFlight 并发去重。
 * - 不复用上次 mount 的结果 —— 用户在配置中心改了 provider/model，重新挂载即可见。
 * - 初始 providers 为空数组（测试桩存在时同步种入，便于单测确定性）。
 * - [v0.0.349] loaded：首次拉取成功后置 true（区分「未加载」与「加载后为空」——
 *   方案编辑器 dangling 预检在未加载时跳过，避免加载窗口误判全条目失效）。
 */
export function useProviders(): {
  providers: ProviderItem[];
  error: string | null;
  loaded: boolean;
} {
  const [providers, setProviders] = useState<ProviderItem[]>(
    testProviders ?? [],
  );
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(testProviders !== null);
  useEffect(() => {
    let cancelled = false;
    fetchProviders()
      .then((list) => {
        if (!cancelled) {
          setProviders(list);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { providers, error, loaded };
}

/**
 * 解析 model 显示名「providerLabel / modelLabel」。
 * - providerId 命中 → `${providerLabel} / ${modelLabel}`
 * - providerId 未命中但 modelId 在某 provider → 回找该 provider 显示（编辑回显 value 只给 modelId 的场景）
 * - 都没命中 → 返回明确失效标记「模型不可用: {modelId}」（v0.0.43 P0-3：session 存的
 *   modelId 在当前 providers 找不到时——provider 被禁用/删除/未加载——不再静默回退到裸
 *   modelId（那样 UI 看起来像"正常选中"），改为明确提示"不可用"，让 topbar chat-model-tag
 *   与 ModelPicker 按钮都能体现"已失效"而非看似"没选中"）。
 */
export function formatModelDisplay(
  sel: ModelSelection | null,
  providers: ProviderItem[],
): string {
  if (!sel) return '未配置模型';
  const p = providers.find((it) => it.id === sel.providerId)
    ?? providers.find((it) => it.models.some((m) => m.modelId === sel.modelId));
  // v0.0.43 P0-3：provider 找不到 → 明确失效标记（不再裸 modelId 静默回退）
  if (!p) return `模型不可用: ${sel.modelId}`;
  const m = p.models.find((it) => it.modelId === sel.modelId);
  const modelLabel = m?.label ?? sel.modelId;
  return `${p.label} / ${modelLabel}`;
}
