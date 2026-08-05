/**
 * memory 纯读工具 —— 对话中按需加载记忆正文（progressive disclosure L1）
 * 参考: specs/tech/agent/memory/[P0]memory_tool.md §2-§6（read/search 契约 + scope + 错误）
 *       对齐样板 specs/tech/agent/skills/[P0]skill_tool.md（skill 纯读工具，纯读 vs 管理分离）
 *
 * 与写侧 `memory_manage` 分离（对称 skill/skill_manage）：
 *   - read   → 取单条完整正文（body + why + howToApply，L1 按需读）
 *   - search → keyword 全字段定位，返 name+intro 轻量索引（不含正文，不变量#5）
 * 二者读取实现均走 memory/query.ts（read 与 memory_manage.read 共享 readMemoryEntry，不变量#4）。
 *
 * 只读（memory_tool §5）：不写、不校验 evolvable、不校验长度——那些是写侧约束。
 *
 * scope 全链统一（v0.0.205）：global/session/group 直通 query 层（无 internal/external 映射层）。
 * 依赖解析：
 *   - session → ctx.config.workdir（SessionConfig 注入的 session ws）
 *   - group   → resolveGroupWsDir(dataDir, {squadId})
 *   - global  → <dataDir>/memory/
 */
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from './types';
import { errorResult, textResult, ToolErrorCode } from './types';
import { readMemoryEntry, searchMemory, type MemoryScope } from '../memory/query';
import {
  resolveSelfGroupWsDir,
  resolveSessionWsDir,
  resolveToolDataDir,
} from './memory-manage-scope';

/** 读取异常 → tool errorResult（not-found / 依赖缺失 / 其他运行时错误分类） */
function mapReadError(e: unknown, op: 'read' | 'search'): ToolRunResult {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found/i.test(msg)) return errorResult(`[${ToolErrorCode.NOT_FOUND}] ${msg}`);
  return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] ${op} failed: ${msg}`);
}

/**
 * memory 纯读工具（单例导出，registry defaultTools 注册）。
 * input.action ∈ read/search；scope（可选）取 global/session/group；read 用 name，search 用 keyword。
 */
export const memoryTool: Tool = {
  definition: {
    name: 'memory',
    description:
      'Read long-term memory on demand (progressive disclosure L1). Actions: ' +
      'read (full single entry by name → body + why + howToApply), ' +
      'search (locate entries by keyword → name+intro index, NOT the body). ' +
      'System prompt shows only name+intro (L0); use read to load a full body, ' +
      'search to find memories whose keyword may live in the body. ' +
      'scope: global (shared long-term) | session (this session) | group (this squad ' +
      'shared; auto-resolved from context; error [invalid_input] not_in_group if caller not in a group); ' +
      'omit to search global + session (group is isolated — not merged into cross-scope). Read-only.',
    intro: 'Read or search long-term memory entries.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'search'],
          description: 'read=load one full entry by name; search=locate entries by keyword',
        },
        scope: {
          type: 'string',
          enum: ['global', 'session', 'group'],
          description:
            'global=shared long-term; session=this session; group=this squad shared ' +
            '(auto-resolved from context; error [invalid_input] not_in_group if not in a group). ' +
            'Omit to span global + session (group is isolated, not merged into cross-scope).',
        },
        name: {
          type: 'string',
          description: 'Entry name to read (required for read; from system prompt L0 catalog / search results).',
        },
        keyword: {
          type: 'string',
          description: 'Keyword to locate entries (required for search; matched against all fields incl. body).',
        },
      },
    },
  },

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    const action = input.action;
    if (action !== 'read' && action !== 'search') {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] action must be one of read|search, got ${String(action)}`);
    }

    // scope 校验（直通 query 层；undefined = 跨 scope）
    const rawScope = input.scope;
    let scope: MemoryScope | undefined;
    if (rawScope !== undefined && rawScope !== null && rawScope !== '') {
      if (rawScope !== 'global' && rawScope !== 'session' && rawScope !== 'group') {
        return errorResult(`[${ToolErrorCode.INVALID_INPUT}] scope must be one of global|session|group, got ${String(rawScope)}`);
      }
      scope = rawScope;
    }

    const dataDir = resolveToolDataDir(ctx);
    const sessionWsDir = resolveSessionWsDir(ctx);
    const groupWsDir = resolveSelfGroupWsDir(ctx, dataDir);

    // 边界依赖校验（显式 scope 缺依赖 → runtime_error / invalid_input；跨 scope 由 query 层静默跳过）
    if (scope === 'session' && !sessionWsDir) {
      return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] session memory requires ctx.config.workdir (caller session workspace not injected)`);
    }
    // group 缺依赖 → not_in_group（语义错：调用方不在任何 squad → invalid_input 而非 runtime_error）
    if (scope === 'group' && !groupWsDir) {
      return errorResult(`[${ToolErrorCode.INVALID_INPUT}] not_in_group`);
    }

    const deps = {
      dataDir,
      ...(sessionWsDir ? { sessionWsDir } : {}),
      ...(groupWsDir ? { groupWsDir } : {}),
    };

    // —— read ——
    if (action === 'read') {
      const name = String(input.name ?? '').trim();
      if (!name) return errorResult(`[${ToolErrorCode.INVALID_INPUT}] name is required`);
      try {
        const entry = readMemoryEntry({ scope, name, ...deps });
        return textResult(JSON.stringify({ action: 'read', scope: entry.scope, entry }));
      } catch (e) {
        return mapReadError(e, 'read');
      }
    }

    // —— search ——
    const keyword = String(input.keyword ?? '').trim();
    if (!keyword) return errorResult(`[${ToolErrorCode.INVALID_INPUT}] keyword is required`);
    try {
      const entries = searchMemory({ scope, keyword, ...deps });
      return textResult(JSON.stringify({ action: 'search', keyword, count: entries.length, entries }));
    } catch (e) {
      return mapReadError(e, 'search');
    }
  },
};
