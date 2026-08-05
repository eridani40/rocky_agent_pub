/**
 * PluginScopeStore — scope 一等实体落盘存储 + CRUD + bootstrap（v0.0.26 F1）
 * 参考: specs/tech/config/[P0]ext_impl_scope.md §2（PluginScopeSchema）+ §3.3（cascade 三步原子）
 *       app/server/src/plugin/plugin-policy-store.ts（CrudStore 封装范式）
 *       app/server/src/config/app-config-service.ts（KV entity 范式）
 *
 * 设计：
 *   - 独立 entity plugin_scope，存 scope 元数据（scopeId/name/description；createdAt 信封注入）
 *   - default scope 系统启动时 bootstrap 确保存在（不可删）；非 default 可动态创建
 *   - deleteScope cascade 三步原子（spec §3.3）：删 plugin_scope record → 删 activation shard
 *     → 删 plugin_policy impl record；用 interface 注入 activationStore + policyStore（T2/T3 实装后注入）
 *   - cascade 各步在 try/catch 内失败反向清理（CrudStore 即时落盘，无事务）
 *
 * scope 业务字段（spec §2，scopeId 表达 spec 的 id 语义，详见 schema_defs/plugin_scope.ts gap 修正）：
 *   - scopeId: snake_case 业务 id（default 常驻；非 default 可创建）
 *   - name: 显示名
 *   - description: 说明（可选）
 */
import type { SchemaDef } from '../persistence/schema-types';
import type { StoredRecord } from '../persistence/crud-types';
import { CompositeStore } from '../persistence/composite';
import { FsCrudStore } from '../persistence/fs-store';
import { ulid } from '../config/ulid';
import { PluginScopeSchema } from './schema_defs/plugin_scope';

/** scope 实体业务字段（不含信封） */
export interface PluginScope {
  /** scope 业务 id（snake_case，default 常驻） */
  scopeId: string;
  /** 显示名 */
  name: string;
  /** 说明（可选，缺省空串对外暴露为统一非空） */
  description: string;
  /** 创建时间（信封 createdAt，ISO8601） */
  createdAt: string;
}

/** default scope 常量（spec §2） */
export const DEFAULT_SCOPE_ID = 'default';

/** default scope 元信息（bootstrap ensure 用） */
const DEFAULT_SCOPE_NAME = 'Default';
const DEFAULT_SCOPE_DESCRIPTION = '默认基线 scope';

/** PluginScopeStore 构造参数 */
export interface PluginScopeStoreOptions {
  /** 数据根目录（FsCrudStore root） */
  root: string;
}

/**
 * cascade 删除依赖（spec §3.3 三步原子的步骤 2/3）。
 * 用 interface 注入（解耦 T2/T3 实装；本 store 不依赖具体实现）。
 * T2 PluginPolicyStore 实装 listImpls/deleteImpl 后注入；
 * T1 ScopeActivationStore 实装 deleteAllByScope 后注入。
 */
export interface ScopeCascadeDeps {
  /** 删某 scope 全部 activation record（整 shard 清） */
  deleteAllActivations(scopeId: string): void;
  /** 列某 scope 下全部 impl policy key（供 cascade 逐条删） */
  listImplKeys(scopeId: string): string[];
  /** 删某 scope 下某 impl policy */
  deleteImpl(scopeId: string, implKey: string): void;
}

/**
 * scope 一等实体存储。封装 CrudStore，对外暴露 scope CRUD + bootstrap ensure default
 * + cascade 删除（依赖注入 activationStore + policyStore）。
 */
export class PluginScopeStore {
  private readonly store: CompositeStore;
  private readonly schema: SchemaDef = PluginScopeSchema;
  /** cascade 依赖（deleteScope 调用前必须注入，否则 cascade 跳过步骤 2/3） */
  private cascadeDeps?: ScopeCascadeDeps;

  constructor(opts: PluginScopeStoreOptions) {
    const fs = new FsCrudStore({ root: opts.root });
    this.store = new CompositeStore().mount(this.schema.entity, fs);
  }

  /** 注入 cascade 依赖（deleteScope 前 must call） */
  setCascadeDeps(deps: ScopeCascadeDeps): void {
    this.cascadeDeps = deps;
  }

  /**
   * 系统启动时确保 default scope 存在（spec §2 bootstrap）。
   * 幂等：缺则创建（name=Default, description=默认基线 scope）；已存在跳过。
   */
  bootstrap(): void {
    const existing = this.get(DEFAULT_SCOPE_ID);
    if (existing) return;
    this.createInternal(DEFAULT_SCOPE_ID, DEFAULT_SCOPE_NAME, DEFAULT_SCOPE_DESCRIPTION);
  }

  /** 列所有 scope（spec §6.2：default 首位 + 按 createdAt 升序） */
  list(): PluginScope[] {
    const rows = this.store.query(this.schema, {});
    const scopes = rows.map(toPluginScope);
    // default 首位 + 其余按 createdAt 升序（稳定排序）
    return scopes.sort((a, b) => {
      if (a.scopeId === DEFAULT_SCOPE_ID) return -1;
      if (b.scopeId === DEFAULT_SCOPE_ID) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  /** 取某 scope（缺返 undefined） */
  get(scopeId: string): PluginScope | undefined {
    const row = this.findByScopeId(scopeId);
    return row ? toPluginScope(row) : undefined;
  }

  /**
   * 创建 scope（spec §6.2）。
   * @throws Error id='default'（不可重复建）/ id 已存在
   */
  create(scopeId: string, name: string, description?: string): PluginScope {
    if (scopeId === DEFAULT_SCOPE_ID) {
      throw new Error(`scope id "${DEFAULT_SCOPE_ID}" 保留，不可创建（系统 bootstrap 唯一）`);
    }
    if (this.findByScopeId(scopeId)) {
      throw new Error(`scope id "${scopeId}" 已存在`);
    }
    return toPluginScope(this.createInternal(scopeId, name, description ?? ''));
  }

  /**
   * 删 scope（spec §6.2 + §3.3 cascade 三步原子）。
   * @throws Error id='default'（不可删）/ scope 不存在
   *
   * cascade 三步（spec §3.3）：
   *   1. 删 plugin_scope record
   *   2. activationStore.deleteAllByScope（整 shard）
   *   3. policyStore.listImpls + 逐条 deleteImpl
   * 失败反向清理（CrudStore 即时落盘，无事务；try/catch 回滚已执行步骤）。
   */
  delete(scopeId: string): void {
    if (scopeId === DEFAULT_SCOPE_ID) {
      throw new Error(`scope "${DEFAULT_SCOPE_ID}" 不可删（基线常驻，spec §2）`);
    }
    const row = this.findByScopeId(scopeId);
    if (!row) {
      throw new Error(`scope "${scopeId}" 不存在`);
    }

    // cascade 步骤 1：删 plugin_scope record（先记录，便于回滚恢复）
    const snapshot = toPluginScope(row);
    this.store.delete(this.schema, castId(row), scopeId);

    // cascade 步骤 2/3：依赖注入则执行；未注入则跳过（容忍 bootstrap 早期阶段）
    if (!this.cascadeDeps) return;
    const deps = this.cascadeDeps;

    // 步骤 2：删 activation shard（先执行，整目录删，失败回滚步骤 1）
    try {
      deps.deleteAllActivations(scopeId);
    } catch (e) {
      // 反向清理：恢复 plugin_scope record（步骤 1 已删，回滚）
      this.createInternal(snapshot.scopeId, snapshot.name, snapshot.description);
      throw new Error(
        `deleteScope cascade 步骤 2（删 activation）失败，已回滚 scope record：${(e as Error).message}`,
      );
    }

    // 步骤 3：逐条删 plugin_policy impl record（先列后删，失败回滚步骤 1+2 不可逆，抛错）
    const implKeys = deps.listImplKeys(scopeId);
    for (const key of implKeys) {
      try {
        deps.deleteImpl(scopeId, key);
      } catch (e) {
        // 注意：步骤 2 已 rmSync 整 activation shard，无法回滚；
        // 步骤 3 部分删除也无法精确回滚（policy 已删部分无法恢复）。
        // CrudStore 即时落盘下三步原子是 best-effort；抛错让上层感知 + 建 bug。
        throw new Error(
          `deleteScope cascade 步骤 3（删 policy impl ${key}）失败，scope record + activation 已清，policy 部分残留：${(e as Error).message}`,
        );
      }
    }
  }

  // ── 内部 ──

  /** 按 scopeId 查 record（shardKey=scopeId 路由） */
  private findByScopeId(scopeId: string): StoredRecord<SchemaDef> | undefined {
    const rows = this.store.query(this.schema, { shardKey: scopeId });
    return rows.find((r) => castScopeId(r) === scopeId);
  }

  /** 内部创建（无 default/重复校验，bootstrap + 回滚用） */
  private createInternal(scopeId: string, name: string, description: string): StoredRecord<SchemaDef> {
    const id = ulid();
    return this.store.put(this.schema, {
      id,
      scopeId,
      name,
      description,
    } as never);
  }
}

// ── 类型收窄助手 + PluginScope 转换 ──

function castId(r: StoredRecord<SchemaDef>): string {
  return (r as unknown as { id: string }).id;
}
function castScopeId(r: StoredRecord<SchemaDef>): string {
  return (r as unknown as { scopeId: string }).scopeId;
}

/** StoredRecord → PluginScope（提取业务字段 + 信封 createdAt） */
function toPluginScope(r: StoredRecord<SchemaDef>): PluginScope {
  const rec = r as unknown as {
    scopeId: string;
    name: string;
    description?: string;
    createdAt: string;
  };
  return {
    scopeId: rec.scopeId,
    name: rec.name,
    description: rec.description ?? '',
    createdAt: rec.createdAt,
  };
}

/**
 * [v0.0.67] 代码声明 scope 元信息 → PluginScope 信封形态转换。
 * 代码声明无落盘时间戳，用 epoch 占位表达「非落盘声明」（供前端 PluginScope 接口兼容）。
 */
export function pluginScopeFromMeta(meta: {
  scopeId: string;
  name: string;
  description: string;
}): PluginScope {
  return {
    scopeId: meta.scopeId,
    name: meta.name,
    description: meta.description,
    createdAt: '1970-01-01T00:00:00.000Z',
  };
}
