/**
 * SchemaDef 运行时校验
 * 参考: specs/tech/persistence/[P0]schema_interface.md §2.2/§2.4（保留字段 + 校验语义）
 *       states/v0.0.2/task.json keyDecisions.idStrategy
 *
 * 两层校验：
 *   - validateSchemaDef(schema)：schema 自身合法性（一次性，注册时调用）
 *       · id 必须声明为 { type: 'ulid', required: true }
 *       · 禁止声明 createdAt/updatedAt/version（信封保留名）
 *       · enum 字段必须带 enumValues
 *   - validateRecord(schema, record)：写入时逐字段校验（put 时调用）
 *       · id 缺失 → PrimaryKeyMissingError
 *       · id ULID 格式非法 → SchemaValidationError
 *       · 必填缺失 / 类型不匹配 / enum 越界 → SchemaValidationError
 *       · record 自带信封字段 → SchemaValidationError
 *
 * 「缺 id」与「id 格式非法」分开报错（spec §2.4 末段），便于调用方区分
 * 「业务漏传 id」与「业务传了非法 id」。
 */
import { SchemaValidationError, PrimaryKeyMissingError } from './errors';
import type { SchemaDef, FieldDef } from './schema-types';

// ============================================================
// 信封保留字段（spec §2.2）：id 业务提供必声明，其余 store 注入禁声明
// ============================================================

/** store 注入的信封字段，实体禁止声明 */
const RESERVED_ENVELOPE_FIELDS = ['createdAt', 'updatedAt', 'version'] as const;

// ============================================================
// ULID 校验：26 字符 Crockford Base32（含小写兼容）
// 字母集：0123456789ABCDEFGHJKMNPQRSTVWXYZ（不含 I/L/O/U）
// ============================================================

const ULID_RE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;

/** 校验字符串是否为合法 ULID 格式 */
export function isValidUlid(value: string): boolean {
  return typeof value === 'string' && ULID_RE.test(value);
}

/** 校验 ISO 8601 UTC 字符串（如 2026-06-19T10:00:00.000Z） */
function isValidIsoDate(value: string): boolean {
  if (typeof value !== 'string') return false;
  // 允许标准 ISO；Date.parse 仅作粗校验，再断言含 'T' 防纯日期
  if (!value.includes('T')) return false;
  return !Number.isNaN(Date.parse(value));
}

// ============================================================
// schema 自身静态校验
// ============================================================

/**
 * 校验 schema 自身合法性（注册/mount 时调用一次）
 * @throws SchemaValidationError 当 schema 非法
 */
export function validateSchemaDef(schema: SchemaDef): void {
  // 1. entity 必填
  if (!schema.entity || typeof schema.entity !== 'string') {
    throw new SchemaValidationError('entity', 'SchemaDef.entity 必填且为非空字符串');
  }

  // 2. engine 必填
  if (schema.engine !== 'file' && schema.engine !== 'sqlite') {
    throw new SchemaValidationError('engine', 'SchemaDef.engine 必须为 "file" 或 "sqlite"');
  }

  // 3. id 必须声明为 { type: 'ulid', required: true }
  const idField = schema.fields?.id;
  if (!idField) {
    throw new SchemaValidationError('id', 'SchemaDef 必须声明保留字段 id');
  }
  if (idField.type !== 'ulid' || idField.required !== true) {
    throw new SchemaValidationError(
      'id',
      'id 必须声明为 { type: "ulid", required: true }',
    );
  }

  // 4. 禁止声明信封保留字段
  for (const reserved of RESERVED_ENVELOPE_FIELDS) {
    if (schema.fields[reserved] !== undefined) {
      throw new SchemaValidationError(
        reserved,
        `${reserved} 是 store 注入的信封字段，实体禁止声明`,
      );
    }
  }

  // 5. enum 字段必须带 enumValues
  for (const [name, def] of Object.entries(schema.fields)) {
    if (def.type === 'enum') {
      if (!Array.isArray(def.enumValues) || def.enumValues.length === 0) {
        throw new SchemaValidationError(
          name,
          'enum 字段必须带非空 enumValues',
        );
      }
    }
  }
}

// ============================================================
// 运行时写入校验
// ============================================================

/** 单字段类型/值校验（必填已在外层处理） */
function checkFieldType(name: string, def: FieldDef, value: unknown): void {
  switch (def.type) {
    case 'string':
      if (typeof value !== 'string') {
        throw new SchemaValidationError(name, `期望 string，实际 ${typeof value}`);
      }
      break;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new SchemaValidationError(name, `期望 number，实际 ${typeof value}`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new SchemaValidationError(name, `期望 boolean，实际 ${typeof value}`);
      }
      break;
    case 'ulid':
      if (!isValidUlid(value as string)) {
        throw new SchemaValidationError(name, '非合法 ULID 格式（26 字符 Crockford Base32）');
      }
      break;
    case 'isoDate':
      if (!isValidIsoDate(value as string)) {
        throw new SchemaValidationError(name, '非合法 ISO 8601 UTC 字符串');
      }
      break;
    case 'enum': {
      const v = value as string;
      // enumValues 在 validateSchemaDef 已保证存在；运行时兜底
      const allowed = def.enumValues ?? [];
      if (!allowed.includes(v)) {
        throw new SchemaValidationError(
          name,
          `值越界，允许：[${allowed.join('|')}]`,
        );
      }
      break;
    }
    case 'json':
      // 不透明，任意 JSON 值均允许（unknown）
      break;
    default:
      // 未覆盖的类型（封闭枚举理论不达此分支）
      throw new SchemaValidationError(name, `未知字段类型 ${(def as FieldDef).type}`);
  }
}

/**
 * 写入时校验 record（put 调用前）
 * @throws PrimaryKeyMissingError 当 record 缺 id
 * @throws SchemaValidationError 当字段校验失败或自带信封字段
 */
export function validateRecord<S extends SchemaDef>(
  schema: SchemaDef,
  record: Record<string, unknown>,
): void {
  // 1. 主键缺失（id 字段不存在或为 undefined）→ PrimaryKeyMissingError
  if (!('id' in record) || record.id === undefined || record.id === null) {
    throw new PrimaryKeyMissingError();
  }

  // 2. record 不得自带信封保留字段（store 注入）
  for (const reserved of RESERVED_ENVELOPE_FIELDS) {
    if (record[reserved] !== undefined) {
      throw new SchemaValidationError(
        reserved,
        `${reserved} 由 store 注入，record 不得自带`,
      );
    }
  }

  // 3. 逐字段校验：必填 + 类型 + enum
  for (const [name, def] of Object.entries(schema.fields)) {
    const has = record[name] !== undefined;
    if (!has) {
      if (def.required === true) {
        throw new SchemaValidationError(name, '必填字段缺失');
      }
      // 可选字段缺失，跳过
      continue;
    }
    checkFieldType(name, def, record[name]);
  }
}
