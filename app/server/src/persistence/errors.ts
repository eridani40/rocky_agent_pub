/**
 * persistence 错误类型
 * 参考: specs/tech/persistence/[P0]schema_interface.md §2.4（错误归类）
 *       states/v0.0.2/task.json keyDecisions.idStrategy
 *
 * 两类错误：
 *   - SchemaValidationError：校验类失败（必填缺失/类型不匹配/enum 越界/ULID 格式非法/
 *     schema 自身非法/实体自带信封字段），携带 field 字段定位
 *   - PrimaryKeyMissingError：record 缺 id（无法寻址，与 ULID 格式非法分开报错，
 *     便于调用方区分「业务漏传 id」与「业务传了非法 id」）
 */

/** 校验类错误，携带出错的字段名 */
export class SchemaValidationError extends Error {
  /** 出错的字段名（如 "id" / "name" / "createdAt"） */
  readonly field: string;

  constructor(field: string, message: string) {
    super(`[field=${field}] ${message}`);
    this.name = 'SchemaValidationError';
    this.field = field;
  }
}

/** 主键缺失错误：record 无 id 字段或 id 为 undefined */
export class PrimaryKeyMissingError extends Error {
  constructor(message = 'record 缺少主键 id（无法寻址）') {
    super(message);
    this.name = 'PrimaryKeyMissingError';
  }
}

// ============================================================
// CrudStore 写入语义错误（spec crud_store_interface §2.4）
// T2 新增，供 envelope 纯逻辑 + 各 engine 复用
// ============================================================

/**
 * 主键已存在错误：PutOptions.mode='insert' 但主键已存在（spec §2.4）。
 * 携带 id 便于调用方定位冲突记录。
 */
export class RecordExistsError extends Error {
  /** 冲突的主键 id */
  readonly id: string;

  constructor(id: string, message = `主键 ${id} 已存在（mode='insert' 拒绝覆盖）`) {
    super(message);
    this.name = 'RecordExistsError';
    this.id = id;
  }
}

/**
 * 记录未找到错误：PutOptions.mode='replace' 要求记录已存在但实际未找到（spec §2.4）。
 * 携带 id 便于定位。
 */
export class RecordNotFoundError extends Error {
  /** 未找到的主键 id */
  readonly id: string;

  constructor(id: string, message = `主键 ${id} 未找到（mode='replace' 要求已存在）`) {
    super(message);
    this.name = 'RecordNotFoundError';
    this.id = id;
  }
}

/**
 * 乐观锁版本冲突错误：PutOptions.ifVersion 与实际 version 不匹配（spec §2.4）。
 * expected = 调用方期望的 version；actual = 落盘当前 version。
 */
export class VersionConflictError extends Error {
  /** 调用方期望的 version（PutOptions.ifVersion） */
  readonly expected: number;
  /** 落盘当前的 version */
  readonly actual: number;
  /** 冲突的主键 id */
  readonly id: string;

  constructor({
    expected,
    actual,
    id,
  }: {
    expected: number;
    actual: number;
    id: string;
  }) {
    super(`主键 ${id} 版本冲突：期望 version=${expected}，实际 version=${actual}`);
    this.name = 'VersionConflictError';
    this.expected = expected;
    this.actual = actual;
    this.id = id;
  }
}

// ============================================================
// CompositeStore 路由错误（T5，crud §3.4）
// ============================================================

/**
 * entity 未挂载错误：CompositeStore 收到 schema.entity 未 mount 的 entity 时抛出
 * （crud_store_interface §3.4：CompositeStore 按 entity 寻址到已挂载 engine 实例）。
 * 携带 entity 名便于调用方排查漏 mount。
 */
export class EntityNotMountedError extends Error {
  /** 未挂载的 entity 名（schema.entity） */
  readonly entity: string;

  constructor(
    entity: string,
    message = `entity "${entity}" 未挂载到 CompositeStore（需先 mount("${entity}", engine)）`,
  ) {
    super(message);
    this.name = 'EntityNotMountedError';
    this.entity = entity;
  }
}
