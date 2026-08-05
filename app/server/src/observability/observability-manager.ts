/**
 * ObservabilityManager — composite adapter（持 child adapter 列表，fan-out 到每项）。
 * 参考: specs/tech/agent/observability/[P0]observability_manager.md §2-§5
 *       specs/tech/agent/observability/[P0]overall.md §6（接口）+ §7（注入）
 *
 * 设计（observability_manager.md）：
 *   - 实现 ObservabilityAdapter 接口（与 LangfuseAdapter/NoopAdapter 同接口）。
 *   - 内部持 child adapter 列表（每 enabled langfuse 项 → 一个 LangfuseAdapter）。
 *   - 对 agent loop 完全透明：loop 调 config.observability.* 不变，背后是 manager fan-out。
 *
 * 核心红线（observability_manager.md §3）：observability 绝不影响 agent loop。
 *   - 第一层（manager 侧）：fan-out 循环中每 child 调用独立 try/catch（safe() 包装）。
 *     一 child 抛只 warn + 跳过该 child，不影响其他 child；不向 loop 抛。
 *   - 第二层（loop 侧）：agent-loop-observability.ts 的 safe() 兜底（v0.0.10 落地）。
 *
 * composite handle（§4）：manager handle 与 child handle 是两套 id 空间。
 *   - manager 对外只暴露 manager handle（trace id=runId，span/gen id=ulid()）。
 *   - 内部 Map（traceMap/spanMap/genMap）记录每 child 的 handle，null=该 child 调用失败/跳过。
 *   - endXxx 用 manager handle 查 Map → 按 child 下标分发（跳过 null）。
 */
import { ulid } from '../config/ulid';
import type { ObservabilityAdapter } from './adapter';
import { LangfuseAdapter } from './langfuse-adapter';
import type {
  GenEnd,
  GenHandle,
  GenStart,
  ObservabilityLevel,
  SpanEnd,
  SpanHandle,
  SpanStart,
  TraceEnd,
  TraceHandle,
  TraceStart,
} from './types';

/**
 * observability 配置项（列表项）。
 * 见 specs/tech/config/[P0]app_config.md §3.9（data = ObservabilityConfigItem[]）。
 *
 * t2 / t1 coder 从 `app/server/src/observability/index.ts` 复 import 此类型
 * （index.ts 重新 export，统一对外路径）。
 */
export interface ObservabilityConfigItem {
  /** 项唯一 id（ULID） */
  id: string;
  /** 人类可读名（UI 展示） */
  name: string;
  /** backend 类型；v0.0.11 仅 langfuse，预留 vendor 扩展 */
  type: 'langfuse';
  /** langfuse host（cloud 或 self-host） */
  baseUrl: string;
  /** langfuse public key */
  publicKey: string;
  /** secret（落盘 redact，见 dev_config §3.4.1） */
  secretKey: string;
  /** 是否启用（manager 只 fan-out 到 enabled 项） */
  enabled: boolean;
  /** 描述（可选） */
  desc?: string;
  /**
   * [v0.0.50] 是否记录物理层 generation（protocol.encode 后 wire body，独立 generation 不带 usage）。
   * 缺省 false（向后兼容 v0.0.49 行为，token/cost 统计不污染）。
   * 改动**不热更新**（重启 / 下 session 生效，manager bootstrap 时算好 per-child 标记）。
   * T4 在 dev_config schema 解析 + bootstrap 透传时填入此字段；T3 仅在 manager 侧消费。
   */
  logPhysical?: boolean;
}

/**
 * [v0.0.50] manager 内部 child 条目：adapter 与 per-child 标记绑定。
 * `logPhysical` 来自构造时对应的 `ObservabilityConfigItem.logPhysical ?? false`，
 * 用于 startGeneration(kind='physical') fan-out 过滤（仅 logPhysical=true child 接收 physical）。
 */
interface ChildEntry {
  adapter: ObservabilityAdapter;
  logPhysical: boolean;
}

/** 把异常转成短消息（warn 用，不暴露完整栈） */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * ObservabilityManager — composite ObservabilityAdapter。
 *
 * 构造：从 items 过滤 `enabled && type==='langfuse'` 的项，每项 new 一个 LangfuseAdapter。
 * 单 item 构造失败（凭证非法等）→ warn + 跳过，不影响其他 item。
 * 空 / 全 disabled → 0 child（等价 Noop，对外不抛）。
 *
 * @param items dev_config.observability 列表（含 disabled 项）
 */
export class ObservabilityManager implements ObservabilityAdapter {
  /** enabled langfuse 项构造出的 child 条目（adapter + per-child logPhysical 标记，顺序与过滤后 items 对齐） */
  private readonly children: ChildEntry[];
  /** 接收的配置项列表（防御性 copy，外部不可 mutate） */
  readonly items: readonly ObservabilityConfigItem[];

  // composite handle 映射（§4）：manager handle.id → 每 child 的 handle（null=该 child 失败/跳过）
  private readonly traceMap = new Map<string, (TraceHandle | null)[]>();
  private readonly spanMap = new Map<string, (SpanHandle | null)[]>();
  private readonly genMap = new Map<string, (GenHandle | null)[]>();

  constructor(items: ObservabilityConfigItem[]) {
    this.items = Object.freeze([...items]);
    this.children = [];
    console.log(`[observability:manager] constructing with ${items.length} config item(s)`);
    for (const item of items) {
      console.log(
        `[observability:manager] item "${item.name}" id=${item.id} type=${item.type} enabled=${item.enabled} baseUrl=${item.baseUrl} publicKey=${item.publicKey}`,
      );
      // 跳过 disabled + 非 langfuse 类型（v0.0.11 仅 langfuse，预留 vendor）
      if (!item.enabled || item.type !== 'langfuse') continue;
      try {
        const adapter = new LangfuseAdapter({
          publicKey: item.publicKey,
          secretKey: item.secretKey,
          baseUrl: item.baseUrl,
        });
        // [v0.0.50] per-child logPhysical 标记：physical kind fan-out 过滤依据（缺省 false）
        this.children.push({ adapter, logPhysical: item.logPhysical ?? false });
        console.log(`[observability:manager] child "${item.name}" created OK`);
      } catch (e) {
        // 单 child 构造失败不影响其他 child（observability_manager.md §3 第一层）
        console.warn(
          `[observability:manager] construct child failed for "${item.name}"(${item.id}): ${errMsg(e)}`,
        );
      }
    }
    console.log(`[observability:manager] total active children: ${this.children.length}`);
  }

  /** 当前 child 数量（测试 / factory 判空用） */
  get childCount(): number {
    return this.children.length;
  }

  /**
   * [v0.0.50] 是否存在任一 logPhysical=true 的 child（bootstrap 时算好，child 列表不热更新）。
   * 上游（如 llm_caller.invoke）据此快速判定是否需要触发 physical 埋点分支——全 false 时
   * 跳过 protocol.encode 后的 physical generation 调用，零开销（等价 v0.0.49 行为）。
   */
  hasPhysicalChild(): boolean {
    return this.children.some((c) => c.logPhysical);
  }

  /**
   * per-child 调用包装：吞错记 warn，返回结果或 null（§3 第一层容错）。
   * @param tag 用于 warn 日志的方法名
   * @param fn 单 child 调用
   * @returns child 返回值；child 抛错则 null
   */
  private safe<T>(tag: string, fn: () => T): T | null {
    try {
      return fn();
    } catch (e) {
      console.warn(`[observability:manager] child ${tag} failed (suppressed): ${errMsg(e)}`);
      return null;
    }
  }

  /**
   * 解析 manager handle → 每 child 的 parent handle 数组（按 child 下标对齐，null=该 child 失败/跳过）。
   *
   * 关键（BUG-001 根因修复）：
   *   - manager 对外暴露的 handle（trace.id=runId，span/gen.id=manager ulid）与 child 自身 handle 是两套 id 空间。
   *   - child 的 startSpan/startGeneration 入参 parent 必须是**该 child 自己**的 handle（trace/span/gen），
   *     而非 manager handle——否则 child 在其内部 Map 找不到 parent → 抛错被 safe() 吞掉 → observation 丢失。
   *   - 本方法把 manager-handle 反查 traceMap/spanMap/genMap → 取出 per-child parent handle 数组返回。
   *
   * @param parent manager 暴露给 loop 的 handle（kind=trace/span/gen）
   * @returns 每 child 对应的 parent handle（null=该 child 此前未建立该 parent）
   */
  private resolveParentPerChild(
    parent: TraceHandle | SpanHandle,
  ): (TraceHandle | SpanHandle | null)[] {
    let arr: (TraceHandle | SpanHandle | null)[] | undefined;
    if (parent.kind === 'trace') {
      arr = this.traceMap.get(parent.id);
    } else {
      // SpanHandle：既可能是 step span 也可能是 tool span，统一查 spanMap
      arr = this.spanMap.get(parent.id);
    }
    if (!arr) {
      // manager 未记录此 parent（例如 manager handle 来自外部 / 此前 child 全失败）：
      // 返回全 null 数组——每个 child 都会用 null parent 触发自查失败被 safe() 吞，避免错乱透传。
      return this.children.map(() => null);
    }
    return arr;
  }

  /**
   * run_start：fan-out 每 child.startTrace，返回 manager TraceHandle（id=runId）。
   * 一 child 抛 → 该 child 在 traceMap 里记 null（endTrace 跳过它）。
   */
  startTrace(p: TraceStart): TraceHandle {
    const childHandles = this.children.map((entry) =>
      this.safe('startTrace', () => entry.adapter.startTrace(p)),
    );
    // manager handle.id 复用 p.id（=runId，loop 已保证全局唯一）
    this.traceMap.set(p.id, childHandles);
    return { kind: 'trace', id: p.id };
  }

  /** run_end：按 manager handle 查 child handles，逐个 endTrace（跳过 null），分发后释放 Map 条目防泄漏 */
  endTrace(h: TraceHandle, p?: TraceEnd): void {
    const childHandles = this.traceMap.get(h.id);
    if (!childHandles) return;
    childHandles.forEach((ch, i) => {
      if (!ch) return; // 该 child startTrace 失败/跳过
      this.safe('endTrace', () => this.children[i]!.adapter.endTrace(ch, p));
    });
    this.traceMap.delete(h.id);
  }

  /**
   * ② LLM 前：fan-out 每 child.startGeneration，返回 manager GenHandle（id=ulid）。
   *
   * 关键（BUG-001 修复）：每个 child 收到的 parent 必须是**该 child 自己**此前 startSpan/startTrace
   * 返回的 handle（在 spanMap/traceMap 里），而非 manager handle——否则 child.resolveParent 抛错被吞，
   * GENERATION observation 丢失（v0.0.11 回归现场：仅 step SPAN 落库，generation/tool span 全丢）。
   *
   * [v0.0.50] fan-out 过滤（§5.3）：
   *   - kind='logical'（默认）：fan-out 到**所有** child（既有行为不变）。
   *   - kind='physical'：**仅** fan-out 到 `logPhysical=true` 的 child；
   *     logPhysical=false 的 child 在 childHandles 里记 null（endGeneration 跳过它，不向其调）。
   *     若所有 child 均 logPhysical=false（hasPhysicalChild()=false），上游应跳过 physical 埋点分支，
   *     此处兜底也只会全 null fan-out（无副作用，仅多一次 ulid + Map.set 开销）。
   */
  startGeneration(p: GenStart): GenHandle {
    const id = ulid();
    const parentsPerChild = this.resolveParentPerChild(p.parent);
    const genKind: 'logical' | 'physical' = p.kind ?? 'logical';
    const childHandles = this.children.map((entry, i) =>
      this.safe('startGeneration', () => {
        // physical kind 只 fan-out 到 logPhysical=true child（§5.3）
        if (genKind === 'physical' && !entry.logPhysical) return null;
        const cp = parentsPerChild[i];
        if (!cp) return null; // 该 child 未建立 parent（其此前 startSpan/startTrace 失败）→ 跳过
        return entry.adapter.startGeneration({ ...p, parent: cp });
      }),
    );
    this.genMap.set(id, childHandles);
    return { kind: 'gen', id, parent: p.parent };
  }

  /** ② LLM 后：用 GenEnd.gen（manager handle）查 child handles，逐个 endGeneration（每 child 收到自己的 gen） */
  endGeneration(e: GenEnd): void {
    const childHandles = this.genMap.get(e.gen.id);
    if (!childHandles) return;
    childHandles.forEach((ch, i) => {
      if (!ch) return;
      this.safe('endGeneration', () =>
        this.children[i]!.adapter.endGeneration({ ...e, gen: ch }),
      );
    });
    this.genMap.delete(e.gen.id);
  }

  /**
   * iteration 起 / tool 跑前：fan-out 每 child.startSpan，返回 manager SpanHandle（id=ulid）。
   *
   * 关键（BUG-001 修复）：每个 child 收到的 parent 必须是**该 child 自己**此前 startSpan/startTrace
   * 返回的 handle（spanMap/traceMap 里），而非 manager handle。step span 的 parent 是 trace（child
   * trace id 与 manager trace id 同为 runId 天然一致，旧实现刚好能用）；但 tool span 的 parent 是
   * step span——manager step-span handle（ulid）≠ child step-span handle（另一 ulid），旧实现直接透传
   * 导致 child.resolveParent 找不到 → tool SPAN 丢失。本修复统一走 resolveParentPerChild 反查。
   */
  startSpan(p: SpanStart): SpanHandle {
    const id = ulid();
    const parentsPerChild = this.resolveParentPerChild(p.parent);
    const childHandles = this.children.map((entry, i) =>
      this.safe('startSpan', () => {
        const cp = parentsPerChild[i];
        if (!cp) return null; // 该 child 未建立 parent → 跳过
        // 运行时 cp 已是 child 自己的 parent handle（kind 与 p.parent 一致）；
        // 经 unknown 转回 SpanStart 联合类型，避免 spread 后联合收窄引发 TS 报错。
        return entry.adapter.startSpan({ ...p, parent: cp } as unknown as SpanStart);
      }),
    );
    this.spanMap.set(id, childHandles);
    return { kind: 'span', id, parent: p.parent };
  }

  /** iteration 末 / tool 跑完：按 manager handle 查 child handles，逐个 endSpan（跳过 null） */
  endSpan(h: SpanHandle, p?: SpanEnd): void {
    const childHandles = this.spanMap.get(h.id);
    if (!childHandles) return;
    childHandles.forEach((ch, i) => {
      if (!ch) return;
      this.safe('endSpan', () => this.children[i]!.adapter.endSpan(ch, p));
    });
    this.spanMap.delete(h.id);
  }

  /**
   * [v0.0.68 R7] 设置 observation 的 level（fan-out 到所有支持 setLevel 的 child）。
   *
   * 设计：composite handle 翻译模式（同 endTrace/endSpan/endGeneration）——
   *   - manager handle（外部 loop 看到的）与 child handle 是两套 id 空间；
   *   - 路由 handle.kind 到 traceMap/spanMap/genMap 反查 per-child handle，逐 child 调
   *     `child.setLevel(childHandle, level)`，把 level 透传到 child 自己的 observation 对象。
   *
   * 用途：run 失败时 LoopObservability.markTraceError 把 trace level 标 ERROR，
   *   使 langfuse UI 顶层显示 ERROR（而非 UNSET）。markTraceError 在 endTrace **前**调用
   *   （run-react-loop.ts），故 trace 类型 handle 调用时 traceMap 必然存在；
   *   span/gen 类型若已 endXxx（Map 已 delete）则 noop（合理：已 end 的 observation 不能再 update）。
   *
   * child 能力探测：child 不实现 setLevel（NoopAdapter / 老 child）时跳过，不影响其他 child。
   * 参考: specs/tech/version_logs/v0.0.68/change_plan.md R7 markTraceError 行（T6 gap 补全）。
   */
  setLevel(h: TraceHandle | SpanHandle | GenHandle, level: ObservabilityLevel): void {
    let arr: (TraceHandle | SpanHandle | GenHandle | null)[] | undefined;
    if (h.kind === 'trace') {
      arr = this.traceMap.get(h.id);
    } else if (h.kind === 'span') {
      arr = this.spanMap.get(h.id);
    } else {
      arr = this.genMap.get(h.id);
    }
    if (!arr) return;
    arr.forEach((ch, i) => {
      if (!ch) return; // 该 child startXxx 失败/跳过 → 无对应 handle
      const childAdapter = this.children[i]!.adapter as ObservabilityAdapter & {
        setLevel?: (
          h: TraceHandle | SpanHandle | GenHandle,
          level: ObservabilityLevel,
        ) => void;
      };
      // 能力探测：child 不支持 setLevel 时跳过（不影响其他 child；manager 不抛）
      if (typeof childAdapter.setLevel !== 'function') return;
      this.safe('setLevel', () => childAdapter.setLevel!(ch!, level));
    });
  }

  /**
   * electron / node 关闭前：Promise.allSettled fan-out 全 child.shutdown
   * （§5：一 child reject 不影响其他，allSettled 不短路）
   */
  async shutdown(): Promise<void> {
    if (this.children.length === 0) return;
    await Promise.allSettled(this.children.map((entry) => entry.adapter.shutdown()));
    // 清理 handle 映射（避免进程不退时内存驻留）
    this.traceMap.clear();
    this.spanMap.clear();
    this.genMap.clear();
  }
}

/**
 * 检测 manager 是否为空（无 enabled 项 → 等价 Noop）。
 * factory / 测试用；manager 自身行为对 0 child 已天然 noop，无需特殊切换实例。
 */
export function isObservabilityManagerEmpty(m: ObservabilityManager): boolean {
  return m.childCount === 0;
}
