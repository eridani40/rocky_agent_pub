/**
 * Panorama 校验引擎类型定义 — 四层校验返回结构.
 * 参考: specs/tech/squad/[P1]panorama_validation.md §1.2
 *
 * 四层：syntax（短路）/ schema（不短路）/ semantic（不短路）/ data_safety.
 * ok=false 时 errors 非空；ok=true 时 errors=[].
 */
import type { PanoramaSchema } from '../dsl/types';

export type ValidationLayer = 'syntax' | 'schema' | 'semantic' | 'data_safety';

export interface ValidationError {
  layer: ValidationLayer;
  /** panorama_ 前缀错误码，见 §9 命名约定 */
  code: string;
  /** DSL 内 JSON path（如 entities.pipeline_run.fields.status） */
  path: string;
  message: string;
  /** 修复建议（含示例片段），喂回 agent 自我修复 */
  suggestion?: string;
}

export interface ValidationWarning {
  layer: 'schema' | 'semantic';
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/**
 * 共享错误工厂 — 四层校验文件共用（去重 e() helper，见 m5）.
 * suggestion 为 falsy 时不写入键，保持 ValidationError 形状干净。
 */
export function makeError(
  layer: ValidationLayer,
  code: string, path: string, message: string, suggestion?: string,
): ValidationError {
  return { layer, code, path, message, ...(suggestion ? { suggestion } : {}) };
}

/**
 * Store 抽象 — L4 数据安全层 + 实例 ref 校验需要查存量数据.
 * Task#3 store 集成时实现此接口传入。
 */
export interface StoreLike {
  /** 取单个实例（ref 闭合校验用） */
  getInstance?(entity: string, id: string): Record<string, unknown> | null;
  /** 列实体全部实例（L4 兼容性检查用） */
  listInstances?(entity: string): Record<string, unknown>[];
  /** id 是否已存在（create 唯一性校验用） */
  hasId?(entity: string, id: string): boolean;
}

export interface ValidationOptions {
  /** dryRun=true 时跑 L1-4 但不落盘（预检）；落盘由调用方决定 */
  dryRun?: boolean;
  /** 存量数据访问（L4 + 实例校验需要） */
  store?: StoreLike;
  /** 旧 DSL（L4 对比基线） */
  oldSchema?: PanoramaSchema;
  /**
   * true = 跳过 L4 数据安全层，把破坏性变更裁决交给 migration 引擎
   * （define 带 migration/approved 时由调用方设置——L4 只校验「无迁移意图」的裸提交，
   *   否则 migration 永远到不了 applyMigration，v0.0.189 生产实证死路）。
   */
  deferDataSafety?: boolean;
}
