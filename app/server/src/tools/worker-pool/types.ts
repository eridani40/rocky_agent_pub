/**
 * worker pool 类型定义 + 白名单常量（单一源）
 * 参考: specs/tech/version_logs/v0.0.307/change_plan.md A/B 组
 *
 * 所有类型仅含可 structuredClone 字段——worker_threads 间通信用 postMessage，
 * 不传函数/类实例/AbortController（structuredClone 序列化边界）。
 *
 * WORKERABLE_TOOL_NAMES 是白名单唯一源——engine.ts isWorkerableTool + worker-entry WHITELIST
 * 都 import 它（change_plan MUST「同一份常量，防两处漂移」）。
 * skill 不在白名单——它依赖 ctx.config.skills（进程内 catalog 对象，无法序列化进 worker）。
 */
import type { ContentBlock } from '../../message/types';
import type { ToolInput } from '../types';

/**
 * 可 worker 化的工具名白名单（唯一源）。
 * 只含纯 IO 工具（依赖仅 workdir/readSet，可序列化）。
 * skill 不在列：依赖 ctx.config.skills catalog（进程内对象）。
 */
export const WORKERABLE_TOOL_NAMES = ['read', 'write', 'edit', 'glob', 'grep'] as const;

/** ToolWorkerRequest 需要传 toolCallId（worker 端补入 ctx，对齐主线程 ctx 结构） */

/**
 * 主线程 → worker 的任务载荷。
 * 与 ToolWorkerRequest 同构（submit 直接序列化 postMessage）。
 * MUST 仅含可 structuredClone 字段（不传函数/类实例/AbortController）。
 */
export interface WorkerPoolTask {
  /** 任务唯一 id（主线程生成，用于匹配响应） */
  id: string;
  /** 工具名（白名单内：read/write/edit/glob/grep） */
  toolName: string;
  /** 工具输入参数（对应 ToolCallBlock.arguments） */
  input: ToolInput;
  /** 工作目录（worker 端构造最小 ctx 用） */
  workdir: string;
  /** 当前 tool_call id（worker 端补入 ctx.toolCallId，对齐主线程结构） */
  toolCallId: string;
  /** 主线程 readSet 快照（Array.from 序列化，worker 端 new Set 初始化，防跨线程断裂） */
  readSet: string[];
}

/**
 * worker → 主线程的结果载荷。
 * readSetAdditions 由 worker 端收集 read/write 成功路径写入的文件路径。
 */
export interface WorkerPoolResult {
  /** 任务 id（与 WorkerPoolTask.id 配对） */
  id: string;
  /** 是否执行成功（true=工具正常返回，false=worker 内异常） */
  ok: boolean;
  /** 工具返回的 content（通常 TextBlock[]） */
  content: ContentBlock[];
  /** 工具自身的 isError 标志（tool.run 返回的 isError） */
  isError: boolean;
  /** worker 端收集的 readSet 增量路径（主线程统一 apply 到 config._readSet） */
  readSetAdditions: string[];
  /** ok=false 时的错误描述 */
  error?: string;
}

/**
 * worker 线程收到的消息（与 WorkerPoolTask 同构）。
 * 主线程 submit 序列化 postMessage 发送。
 */
export interface ToolWorkerRequest {
  id: string;
  toolName: string;
  input: ToolInput;
  workdir: string;
  toolCallId: string;
  /** 主线程 readSet 快照（与 WorkerPoolTask 同构） */
  readSet: string[];
}

/**
 * worker 线程回的消息。
 * content 为序列化 JSON（structuredClone 边界，不传函数/类实例）。
 */
export interface ToolWorkerResponse {
  id: string;
  ok: boolean;
  content: unknown;
  isError: boolean;
  readSetAdditions: string[];
  error?: string;
}
