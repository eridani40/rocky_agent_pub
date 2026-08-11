/**
 * worker 线程入口
 * 参考: specs/tech/version_logs/v0.0.307/change_plan.md A 组
 *       app/server/src/tools/browser/node-worker-driver.ts（子进程 worker 模式参考）
 *
 * worker_threads 线程入口：parentPort.on('message') → 按 toolName 路由到白名单工具实现
 * → 构造最小 ctx { workdir, readSet, toolCallId } → await tool.run(input, ctx)
 * → 收集 readSet 增量 → postMessage 回主线程。
 *
 * 约束：
 *   - MUST 只依赖白名单工具模块（不 import engine/registry 防整包加载进 worker）
 *   - MUST try/catch 全包（worker 内任何异常回消息不崩溃线程）
 *   - 白名单统一从 types.ts WORKERABLE_TOOL_NAMES import（防两处漂移）
 *   - 静态 import（非 require）兼容 vitest ESM + bun CJS 两种 worker 加载环境
 */
import { parentPort } from 'node:worker_threads';
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../types';
import type { ContentBlock } from '../../message/types';
import type { ToolWorkerRequest, ToolWorkerResponse } from './types';
import { WORKERABLE_TOOL_NAMES } from './types';
// 静态 import 白名单工具模块（dev/test 由 pool.ts esbuild bundle 编译；
// packaged 由 tsc 编译成 CJS require——两种环境都不需要文件扩展名）
import { fileReadTool } from '../file-read';
import { fileWriteTool } from '../file-write';
import { fileEditTool } from '../file-edit';
import { fileGlobTool } from '../file-glob';
import { fileGrepTool } from '../file-grep';

/**
 * 白名单工具映射：toolName → Tool 实例。
 * 从 WORKERABLE_TOOL_NAMES 派生 key（单一源，增删白名单只改 types.ts 一处）。
 * skill 不在列——它依赖 ctx.config.skills catalog（进程内对象，无法序列化进 worker）。
 */
const WHITELIST: Record<string, Tool> = {
  read: fileReadTool,
  write: fileWriteTool,
  edit: fileEditTool,
  glob: fileGlobTool,
  grep: fileGrepTool,
};

/**
 * worker 线程入口：监听 parentPort 消息，按 toolName 路由执行。
 * 全程 try/catch 包裹——任何异常都回消息 { ok:false } 不崩溃线程。
 */
export function workerEntry(): void {
  if (!parentPort) {
    // 非 worker 环境调用（如 UT 直接 import）—— 无操作
    return;
  }

  parentPort.on('message', (req: ToolWorkerRequest) => {
    handleRequest(req).catch((e) => {
      const resp: ToolWorkerResponse = {
        id: req.id,
        ok: false,
        content: [],
        isError: true,
        readSetAdditions: [],
        error: `worker uncaught: ${e instanceof Error ? e.message : String(e)}`,
      };
      parentPort?.postMessage(resp);
    });
  });
}

/** 处理单个工具执行请求 */
async function handleRequest(req: ToolWorkerRequest): Promise<void> {
  const resp = await executeWhitelistedTool(req);
  parentPort?.postMessage(resp);
}

/**
 * 执行白名单工具，返回完整响应。
 * 内部 try/catch 全包，保证任何异常都转为 { ok:false } 响应。
 */
async function executeWhitelistedTool(req: ToolWorkerRequest): Promise<ToolWorkerResponse> {
  try {
    const tool = WHITELIST[req.toolName];
    if (!tool) {
      return {
        id: req.id,
        ok: false,
        content: [],
        isError: true,
        readSetAdditions: [],
        error: `unknown tool in worker whitelist: ${req.toolName}`,
      };
    }

    // 构造最小 ctx：workdir + 临时 readSet + toolCallId
    // toolCallId 补入 ctx 对齐主线程 ctx 结构（白名单工具核心 IO 路径不依赖它，
    // 但保持结构一致性防未来工具扩展读取）
    const readSet = new Set<string>(req.readSet);
    const ctx: ToolCtx = {
      config: {
        tools: [],
        workdir: req.workdir,
      },
      workdir: req.workdir,
      readSet,
      toolCallId: req.toolCallId,
    };

    const result: ToolRunResult = await tool.run(req.input as ToolInput, ctx);

    const readSetAdditions = Array.from(readSet);

    return {
      id: req.id,
      ok: true,
      content: result.content as unknown as ContentBlock[],
      isError: result.isError,
      readSetAdditions,
    };
  } catch (e) {
    return {
      id: req.id,
      ok: false,
      content: [],
      isError: true,
      readSetAdditions: [],
      error: `worker execution error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// 自动启动 worker 入口（当作为 worker 线程加载时）
workerEntry();
