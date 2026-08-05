/**
 * memory_manage 工具 —— agent 自主管理 memory 写侧（write/archive/list/read）
 * 参考: specs/tech/agent/memory/[P0]memory_manage_tool.md §2 接口 / §5 长度硬限 / §5.1 evolvable gate / §5.2 路由
 *       specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4（统一 scope + dir store）
 *
 * 设计要点（§6）：不审批直接落盘；write upsert（同 name 更新）；archive 不 delete；list 只回 metadata（控 token）。
 *   read 与独立 `memory` 纯读工具**共享** query.readMemoryEntry（不变量#4，不新造第二份读源）。
 *
 * scope 全链统一（v0.0.205）+ 写侧必填（v0.0.238）：global/session/group 直通 dir store：
 *   - global  → <dataDir>/memory/（read 缺省 global；write/archive 必填 + 按 biz 校验）
 *   - session → <ctx.config.workdir>/.rocky/memory/
 *   - group   → <resolveGroupWsDir(squadId)>/.rocky/memory/
 *
 * evolvable gate（不变量#3，只挡 agent 进化性写）：agent write/archive 传 enforceEvolvable=true，更新既有
 *   evolvable=false / archive → service 层原子拒绝（MemoryNonEvolvableError，单点判定，本层不重复）。
 *   **权限检查（gate）先于载荷校验（type）**：真 LLM 更新常只传 {name,intro,body} 省略 type——write 省 type 时
 *   继承既有 type（见 probeExistingType），使进化性写抵达 service gate（否则被 type 校验抢先拦成 entry.type invalid，BUG-001）；
 *   创建（无既有）仍要求显式 type。agent 不碰 evolvable（payload 不含），新建默认 evolvable=true。字符硬限（intro≤50 / body≤500）亦在
 *   service 层强制（MemoryCharLimitError）。二者错误码统一 invalid_input。注册范围（§7.1）：rocky/studio-leader/studio-mate。
 */
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from './types';
import { errorResult, textResult, ToolErrorCode } from './types';
import { listMetas, type MemoryScope, type MemoryType, type MemoryWriteInput } from '../memory/memory-dir-store';
import { archiveEntry, writeEntry } from '../memory/memory-dir-write';
import { MemoryNonEvolvableError, MemoryCharLimitError, MemoryQuotaExceededError } from '../memory/policy';
import type { AppConfigService } from '../config/app-config-service';
import { readMemoryEntry } from '../memory/query';
import { ROUTING_DECISION_PROMPT } from '../prompts/routing-decision';
import {
  AVAILABLE_SCOPES_BY_BIZ,
  resolveBizScopeKind,
  scopeRequiredErrorText,
  scopeUnavailableErrorText,
} from '../agent/biz-scope-rules';
import {
  notInGroupError,
  parseListScope,
  parseScope,
  probeExistingType,
  resolveScopeDir,
  resolveSelfGroupWsDir,
  resolveSessionWsDir,
  resolveToolDataDir,
  sessionWsMissing,
  toListMeta,
} from './memory-manage-scope';

// —— 校验：从弱类型 ToolInput 收敛到强类型 ——

function isAction(a: unknown): a is 'write' | 'archive' | 'list' | 'read' {
  return a === 'write' || a === 'archive' || a === 'list' || a === 'read';
}
function isType(t: unknown): t is MemoryType {
  return t === 'user' || t === 'feedback' || t === 'project' || t === 'reference';
}

/** 把校验错误转成 isError 结果（invalid_input；run 入口统一处理） */
function invalid(msg: string): ToolRunResult {
  return errorResult(`[${ToolErrorCode.INVALID_INPUT}] ${msg}`);
}

/**
 * 解析写侧（write/archive）scope：必填 + 按 biz 校验。
 * - 缺失（undefined/null/''）→ invalid(scopeRequiredErrorText(biz))（引导 LLM 自修正）
 * - 合法三值但本 biz 不可用 → invalid(scopeUnavailableErrorText(biz, got))
 * - 合法三值且 biz 可用 → 直通
 * 非法值（如 'squad'）由 caller 用 parseScope 拦截（见 write/archive 分支）。
 */
function parseWriteScope(input: ToolInput, ctx: ToolCtx): MemoryScope | ToolRunResult {
  const raw = input.scope;
  if (raw === undefined || raw === null || raw === '') {
    return invalid(scopeRequiredErrorText(resolveBizScopeKind(ctx.config)));
  }
  const scope = parseScope(raw);
  if (!scope) return invalid(`write/archive scope must be global|session|group, got ${String(raw)}`);
  const biz = resolveBizScopeKind(ctx.config);
  if (!AVAILABLE_SCOPES_BY_BIZ[biz].includes(scope)) {
    return invalid(scopeUnavailableErrorText(biz, scope));
  }
  return scope;
}

/**
 * memory_manage 工具（单例导出）。input.action ∈ write/archive/list/read；scope 写侧必填无默认（read 缺省 global，list 已必填）。
 * 路由提示词内嵌 ROUTING_DECISION_PROMPT（单一常量，不变量#6）+ memory session 语义消歧。
 */
export const memoryManageTool: Tool = {
  definition: {
    name: 'memory_manage',
    description:
      'Manage long-term memory entries (self-evolution). Actions: ' +
      'write (upsert entry by name; intro ≤50 chars / body ≤500 chars, hard limit), ' +
      'archive (mark archived, not delete), ' +
      'list (metadata only), read (full single entry — or use the `memory` tool). ' +
      'Memory is structured + managed — never use Read/Edit on memory files directly.\n\n' +
      ROUTING_DECISION_PROMPT +
      '\n\n' +
      'scope is REQUIRED for write/archive (no default — omitted scope or a scope not available for your biz is rejected with the available list). ' +
      'For memory, "session" means THIS single private session only (truly per-session, not shared) — ' +
      'unlike a skill\'s "session" which is project-level (workspace). ' +
      '"group" = this squad\'s shared memory (auto-resolved from context; ' +
      'error [invalid_input] not_in_group if caller not in a squad). ' +
      'read defaults to "global" when scope is omitted (read is permissive). ' +
      'You cannot set evolvable — new entries are evolvable by default; ' +
      'updating a non-evolvable entry (or archiving it) is rejected.',
    intro: 'Write and manage long-term memory entries.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['write', 'archive', 'list', 'read'], description: 'Operation to perform on memory entries' },
        scope: {
          type: 'string',
          enum: ['global', 'session', 'group', 'all'],
          description:
            'Target scope. REQUIRED for write/archive (no default — invalid scope or omitted scope is rejected with the available list). ' +
            'global=shared long-term; session=this private session; group=this squad\'s shared memory ' +
            '(auto-resolved from context; error [invalid_input] not_in_group if caller not in a group). ' +
            'read defaults to global when omitted. list also accepts "all" (merge global + session + group; group merged only when caller in a group).',
        },
        name: {
          type: 'string',
          description: 'Entry name (for archive/read). Must match a name returned by list.',
        },
        entry: {
          type: 'object',
          description:
            'Entry payload (required for write). Upsert by name: creates a new entry if `name` does not ' +
            'already exist under the target scope, otherwise updates the existing one. ' +
            'name/intro/body are required when creating a new entry; type is also required when creating ' +
            '(no existing entry to inherit it from). When UPDATING an existing entry (name already exists), ' +
            'type may be omitted — it is inherited from the existing entry.',
          properties: {
            name: { type: 'string', description: 'Unique slug (kebab-case recommended). Required.' },
            intro: {
              type: 'string',
              description:
                'One-line summary of this memory (was "description"; renamed to avoid clashing with the ' +
                'JSON-schema keyword). Required.',
            },
            type: {
              type: 'string',
              enum: ['user', 'feedback', 'project', 'reference'],
              description:
                'feedback/project should include why+howToApply. Required when creating a NEW entry ' +
                '(name not yet used in this scope); may be omitted when updating an existing entry — it is ' +
                'inherited from the entry already on record, do not guess/re-supply it.',
            },
            body: { type: 'string', description: 'Main content (markdown), ≤500 chars. Required.' },
            why: { type: 'string', description: 'Why this matters (feedback/project)' },
            howToApply: { type: 'string', description: 'How to apply going forward' },
          },
        },
      },
    },
  },

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    const action = input.action;
    if (!isAction(action)) {
      return invalid(`action must be one of write|archive|list|read, got ${String(action)}`);
    }
    const dataDir = resolveToolDataDir(ctx);

    // —— write（scope 必填 + 按 biz 校验；agent 路径 enforceEvolvable+新建 evolvable=true）——
    if (action === 'write') {
      const scope = parseWriteScope(input, ctx);
      if (typeof scope === 'object' && 'isError' in scope) return scope;
      const e = input.entry as Record<string, unknown> | undefined;
      if (!e || typeof e !== 'object') return invalid('write requires entry payload');
      // gate-before-type（BUG-001）：省 type 时继承既有 type
      const type = isType(e.type) ? e.type : probeExistingType(scope, String(e.name ?? '').trim(), ctx, dataDir);
      if (!isType(type)) return invalid(`entry.type invalid: ${String(e.type)}`);
      const payload: MemoryWriteInput = {
        name: String(e.name ?? ''),
        intro: String(e.intro ?? e.description ?? ''),
        type,
        body: String(e.body ?? ''),
        why: typeof e.why === 'string' ? e.why : undefined,
        howToApply: typeof e.howToApply === 'string' ? e.howToApply : undefined,
      };
      // store: {scope, appConfig} 透传 writeLocked create 分支做存储配额检查（v0.0.247）
      //   appConfig duck-typed 取（同 see-image/web-fetch 工具模式）；缺省 undefined → 不查配额（向后兼容）
      const writeOpts = {
        enforceEvolvable: true,
        defaultEvolvable: true,
        source: 'agent' as const,
        store: {
          scope,
          appConfig: (ctx.config.appConfig ?? null) as AppConfigService | null,
        },
      };
      const dir = resolveScopeDir(scope, ctx, dataDir);
      if (!dir) {
        return scope === 'group' ? notInGroupError() : sessionWsMissing();
      }
      try {
        const out = await writeEntry(dir, payload, writeOpts);
        return textResult(JSON.stringify({ ok: true, action: 'write', scope, entry: out }));
      } catch (err) {
        if (
          err instanceof MemoryCharLimitError ||
          err instanceof MemoryNonEvolvableError ||
          err instanceof MemoryQuotaExceededError
        ) {
          return invalid(err.message);
        }
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] write failed: ${msg}`);
      }
    }

    // —— archive（scope 必填 + 按 biz 校验；agent 路径 enforceEvolvable：evolvable=false 拒绝）——
    if (action === 'archive') {
      const scope = parseWriteScope(input, ctx);
      if (typeof scope === 'object' && 'isError' in scope) return scope;
      const name = String(input.name ?? '').trim();
      if (!name) return invalid('archive requires name');
      const dir = resolveScopeDir(scope, ctx, dataDir);
      if (!dir) {
        return scope === 'group' ? notInGroupError() : sessionWsMissing();
      }
      try {
        const out = await archiveEntry(dir, name, { enforceEvolvable: true });
        return textResult(JSON.stringify({ ok: true, action: 'archive', scope, entry: out }));
      } catch (err) {
        if (err instanceof MemoryNonEvolvableError) return invalid(err.message);
        const msg = err instanceof Error ? err.message : String(err);
        if (/not found/i.test(msg)) return errorResult(`[${ToolErrorCode.NOT_FOUND}] ${msg}`);
        return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] archive failed: ${msg}`);
      }
    }

    // —— list（meta 含 evolvable + scope 回显；all = 合并 global + session + group，group 段软取）——
    if (action === 'list') {
      const listScope = parseListScope(input.scope);
      if (!listScope) return invalid(`list scope must be global|session|group|all, got ${String(input.scope)}`);
      // 显式 'group' → 硬取 group ws（无则 not_in_group）；'all' → 软取（group 段静默跳过）
      if (listScope === 'group' && !resolveSelfGroupWsDir(ctx, dataDir)) return notInGroupError();
      if (listScope === 'session' && !resolveSessionWsDir(ctx)) return sessionWsMissing();
      try {
        const entries: Array<ReturnType<typeof toListMeta>> = [];
        const scopes: MemoryScope[] =
          listScope === 'all' ? ['global', 'session', 'group'] : [listScope];
        for (const s of scopes) {
          const dir = resolveScopeDir(s, ctx, dataDir);
          if (!dir) continue; // all 模式软跳过缺依赖的段
          for (const m of listMetas(dir).filter((x) => !x.archived)) entries.push(toListMeta(m, s));
        }
        return textResult(JSON.stringify({ action: 'list', scope: listScope, count: entries.length, entries }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] list failed: ${msg}`);
      }
    }

    // —— read（走 query.readMemoryEntry 单点，不变量#4；scope 缺省 global 直通回显）——
    // read 侧宽容：scope 缺失 → 默认 global（不收窄；与 write/archive 的必填约束对称保留）。
    // 非法值（如 'squad'）→ 仍 invalid_input（与既有口径一致）。
    const rawScope = input.scope;
    const scope = rawScope === undefined || rawScope === null || rawScope === ''
      ? 'global'
      : parseScope(rawScope);
    if (!scope) return invalid(`read scope must be global|session|group, got ${String(rawScope)}`);
    const name = String(input.name ?? '').trim();
    if (!name) return invalid('read requires name');

    const sessionWsDir = resolveSessionWsDir(ctx);
    const groupWsDir = resolveSelfGroupWsDir(ctx, dataDir);
    if (scope === 'session' && !sessionWsDir) return sessionWsMissing();
    if (scope === 'group' && !groupWsDir) return notInGroupError();

    try {
      const entry = readMemoryEntry({
        scope,
        name,
        dataDir,
        ...(sessionWsDir ? { sessionWsDir } : {}),
        ...(groupWsDir ? { groupWsDir } : {}),
      });
      return textResult(JSON.stringify({ action: 'read', scope: entry.scope, entry }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(msg)) return errorResult(`[${ToolErrorCode.NOT_FOUND}] ${msg}`);
      return errorResult(`[${ToolErrorCode.RUNTIME_ERROR}] read failed: ${msg}`);
    }
  },
};
