/**
 * SessionTypePolicy — SessionTypeProfile 的运行时读取接口（profile 单源 + resolveToolSet 三层一致）
 * 参考: specs/tech/agent/session/[P0]session_type_profile.md §6
 *       specs/tech/agent/tools/[P0]tool_policy.md §3
 *
 * 职责：
 *   - profile(kind) — 返回继承合并后的 ResolvedSessionProfile（纯数据，无逻辑）
 *   - resolveToolSet(kind, instanceOverride?) — bound ∩ instanceOverride → {tools, toolDefinitions, allowedTools}
 *
 * 不在 interface 里：scopeId（= canonical id 拼接）、groupKey（= sid+runKind 拼接）、
 *   enabled/各布尔字段（profile 字段直读）、caller 门控（kind 谓词 helper）。
 */
import type { SessionKind } from '@app/shared';
import type { Tool, ToolDefinition } from '../tools/types';
import type { ResolvedSessionProfile } from './session-type-profile-loader';
import type { SessionTypeProfileLoader } from './session-type-profile-loader';

/** resolveToolSet 入参：实例 override（spawn eff.tools / subAgentConfig.tools） */
export interface ResolveToolSetOverride {
  tools?: string[];
}

/** resolveToolSet 出参：三层共享的三件套（保注册序 + 剔幽灵名） */
export interface ResolvedToolSet {
  /** config.tools 实例白名单（registry Tool[] 的子集，保注册序） */
  tools: Tool[];
  /** 给 LLM 的 toolDefinitions（callLLMForMain/stage-llm 消费，保注册序） */
  toolDefinitions: ToolDefinition[];
  /** 执行层白名单名表（RunSpec.allowedTools，engine.execute 消费，保注册序） */
  allowedTools: string[];
}

/** SessionTypePolicy interface（v0.0.204 收缩版，仅两方法） */
export interface SessionTypePolicy {
  /** 继承合并后的 profile（唯一读取入口；纯数据，无逻辑） */
  profile(kind: SessionKind): ResolvedSessionProfile;
  /**
   * P6 唯一真决策：bound（profile，runKind 粒度）∩ instanceOverride。
   * - main-run 无 override → tools = bound
   * - subagent / 实例白名单场景 → tools = bound ∩ instanceOverride.tools
   * 保 allTools 注册序 + 剔幽灵名（bound 中的工具名如未注册，自动过滤掉）
   */
  resolveToolSet(kind: SessionKind, instanceOverride?: ResolveToolSetOverride): ResolvedToolSet;
}

/** Policy 构造参数 */
export interface SessionTypePolicyOptions {
  /** 已 loadAll + validateAll 的 loader */
  loader: SessionTypeProfileLoader;
  /** registry.defaultTools(workdir) 全集（按注册序） */
  allTools: Tool[];
  /** allTools.map(t => t.definition)，调用方算（保注册序与 allTools 一致） */
  allToolDefinitions: ToolDefinition[];
}

/**
 * 生产实现：把 loader + registry allTools 组装为 SessionTypePolicy。
 *
 * 启动期 bootstrap 调：
 *   const loader = new SessionTypeProfileLoader({...});
 *   loader.loadAll();
 *   loader.validateAll({names: new Set(allTools.map(t => t.definition.name))});
 *   const policy = new SessionTypePolicyImpl({loader, allTools, allToolDefinitions});
 */
export class SessionTypePolicyImpl implements SessionTypePolicy {
  private readonly loader: SessionTypeProfileLoader;
  private readonly allTools: Tool[];
  private readonly allToolDefinitions: ToolDefinition[];
  /** name → Tool 映射（保注册序遍历用） */
  private readonly toolByName: Map<string, Tool>;
  /** name → ToolDefinition 映射（保注册序遍历用） */
  private readonly defByName: Map<string, ToolDefinition>;

  constructor(opts: SessionTypePolicyOptions) {
    this.loader = opts.loader;
    this.allTools = opts.allTools;
    this.allToolDefinitions = opts.allToolDefinitions;
    this.toolByName = new Map(this.allTools.map((t) => [t.definition.name, t]));
    this.defByName = new Map(this.allToolDefinitions.map((d) => [d.name, d]));
  }

  profile(kind: SessionKind): ResolvedSessionProfile {
    // canonical id 即 profile id（${biz}-${role}:${derivation}:${runKind}）
    return this.loader.profile(kind.canonicalId());
  }

  resolveToolSet(kind: SessionKind, instanceOverride?: ResolveToolSetOverride): ResolvedToolSet {
    const bound = this.profile(kind).toolBound;
    const boundSet = new Set(bound);
    // instanceOverride ∩ bound（无 override 即全集 bound；subagent 带 eff.tools 走交集）
    const allowedNames =
      instanceOverride?.tools !== undefined
        ? new Set(instanceOverride.tools.filter((n) => boundSet.has(n)))
        : new Set(bound);

    // 保注册序遍历 allTools/allToolDefinitions（与原 resolveTools 行为一致）
    const tools: Tool[] = [];
    const toolDefinitions: ToolDefinition[] = [];
    const allowedTools: string[] = [];
    for (const t of this.allTools) {
      const name = t.definition.name;
      if (allowedNames.has(name)) {
        tools.push(t);
        toolDefinitions.push(this.defByName.get(name) ?? t.definition);
        allowedTools.push(name);
      }
    }
    return { tools, toolDefinitions, allowedTools };
  }
}
