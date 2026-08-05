/**
 * config 模块入口 — app_config 域 service + schema re-export
 * 参考: specs/tech/config/index.md
 *
 * 使用方：`import { AppConfigService } from '@app/server/config'`
 *
 * 模块组成：
 *   - schema_defs/app_config.ts：TS SchemaDef（as const satisfies SchemaDef）
 *   - kv-config-service.ts：通用 KV 基类（get/set 逻辑共享，不聚合不回退）
 *   - app-config-service.ts：薄壳子类（绑定 AppConfigSchema）
 *   - schema_defs/connector_config.ts + connector-config-service.ts：
 *     连接器 switch intent 持久化（独立 config 域，id → enabled 单值形态）
 *   - ulid.ts：ULID 主键生成器（service 写 record 时生成 id）
 */
export { AppConfigService } from './app-config-service';
export { KvConfigService, type KvConfigServiceOptions } from './kv-config-service';
export { AppConfigSchema } from './schema_defs/app_config';
export type { AppConfigRecord } from './schema_defs/app_config';
// connector_config（连接器 switch intent 持久化；与 app_config 正交的独立 config 域）
export { ConnectorConfigService, type ConnectorConfigServiceOptions } from './connector-config-service';
export { ConnectorConfigSchema } from './schema_defs/connector_config';
export type { ConnectorConfigRecord } from './schema_defs/connector_config';
export { ulid } from './ulid';
