/**
 * bootstrap-late-bound — 前向引用 holder 集合（agent-phase lambdas 在 activate 时读 .value）
 *
 * 纯 move 自 bootstrap-agent-phase.ts（v0.0.156 结构性拆分）。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.2 agent-phase 行（lateBound 模式）
 *
 * 设计：lateBound 模式复用原 bootstrap.ts 的 cronToolDepsRef 模式（{ value: T } holder），
 * 扩展到全部跨 phase 前向引用。main 创建 holder，agent-phase lambdas 读 .value，
 * 后续 phase（scheduler/connectors/search）填充 .value。
 *
 * 时序保证（INV-C-1）：lambdas 在 agent activate 时才真正执行（不是定义时），
 * 那时所有 phase 已完成 → lateBound.X.value 已填充。
 */
import type { ConnectorManager } from './tools/browser/connector-manager';
import type { DriverRegistry } from './tools/browser/pick-driver';
import type { BrowserInstanceManager } from './tools/browser/instance-manager';
import type { ComputerNativePort } from './platform/computer/native-port';
import type { SearchEngine } from './persistence/search-engine';
import type { SessionWorkspaceManager } from './agent/session-workspace-manager';
// [v0.0.210] Academy —— TrainingEngine 跨 phase 前向引用（agent-phase 后、main 内装配）
import type { TrainingEngine } from './academy/training-engine';
import type { AcademyStore } from './academy/academy-store';

/**
 * 前向引用 holder 集合（lambdas 在 activate 时读 .value；main 在后续 phase 完成后填充）。
 */
export interface LateBoundRefs {
  /** cronToolDeps — 由 scheduler-phase 填充（bootScheduler 产出） */
  cronToolDeps: { value: unknown };
  /** connectorManager — 由 connectors-phase 填充 */
  connectorManager: { value: ConnectorManager | undefined };
  /** browserDriverRegistry — 由 connectors-phase 填充 */
  browserDriverRegistry: { value: DriverRegistry | undefined };
  /** browserInstanceManager — 由 connectors-phase 填充（headless/managed-profile 常驻实例） */
  browserInstanceManager: { value: BrowserInstanceManager | undefined };
  /** computerNativePort — 由 connectors-phase 填充（三态降级可能 undefined） */
  computerNativePort: { value: ComputerNativePort | undefined };
  /** searchEngine — 由 search-phase 填充（装配失败 → undefined） */
  searchEngine: { value: SearchEngine | undefined };
  /** workspaceManager — 由 main 填充（search-phase 内构造后回填） */
  workspaceManager: { value: SessionWorkspaceManager | undefined };
  /** [v0.0.210] trainingEngine — 由 main 在 agent-phase 后填充（academy manage-task 工具用） */
  trainingEngine: { value: TrainingEngine | undefined };
  /** [v0.0.210] academyStore — 由 store-phase 填充（academy 工具用；store-phase 早于 agent-phase） */
  academyStore: { value: AcademyStore | undefined };
}

/** 创建前向引用 holder 集合（main 在 agentPhase 前创建，后续 phase 填充）。 */
export function createLateBoundRefs(): LateBoundRefs {
  return {
    cronToolDeps: { value: undefined },
    connectorManager: { value: undefined },
    browserDriverRegistry: { value: undefined },
    browserInstanceManager: { value: undefined },
    computerNativePort: { value: undefined },
    searchEngine: { value: undefined },
    workspaceManager: { value: undefined },
    trainingEngine: { value: undefined },
    academyStore: { value: undefined },
  };
}
