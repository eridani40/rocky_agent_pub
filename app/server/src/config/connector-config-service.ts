/**
 * ConnectorConfigService — connector_config 域的逻辑服务
 * 参考: specs/tech/config/[P1]connectors.md §4（持久化 intent）+ §5（ConnectorManager 用）
 *
 * 与 KvConfigService（app/dev_config）的差异：
 *   - 那两域是 (group, key) → data 的 KV 形态，本域是 id → enabled 的单值形态。
 *   - 故不复用 KvConfigService 基类，独立实现 getEnabled/setEnabled（id 寻址）。
 *
 * 语义（spec §4）：
 *   - getEnabled(id)：record 缺失或 enabled=false → 返 false（启动态 off）。
 *   - setEnabled(id, enabled)：upsert 落盘 intent（用户 toggle on/off 时 ConnectorManager 调）。
 *
 * 底经 CompositeStore mount connector_config → FsCrudStore。
 */
import { ConnectorConfigSchema } from './schema_defs/connector_config';
import { CompositeStore } from '../persistence/composite';
import { FsCrudStore } from '../persistence/fs-store';

/** ConnectorConfigService 构造参数 */
export interface ConnectorConfigServiceOptions {
  /** 数据根目录（FsCrudStore root，所有 entity 路径从此起拼接） */
  root: string;
}

/**
 * connector_config 域逻辑服务。
 *
 * 用法（ConnectorManager 持有）：
 *   const svc = new ConnectorConfigService({ root: DATA_DIR });
 *   if (svc.getEnabled('browser')) { /* intent=on → 自动重连 *\/ }
 *   svc.setEnabled('browser', true);  // toggle on 持久化 intent
 */
export class ConnectorConfigService {
  private readonly store: CompositeStore;

  constructor(opts: ConnectorConfigServiceOptions) {
    const fs = new FsCrudStore({ root: opts.root });
    this.store = new CompositeStore().mount(ConnectorConfigSchema.entity, fs);
  }

  /**
   * 读 connector 的持久化 intent。
   * @param id connector id（"browser"）
   * @returns record 缺失或 enabled=false → false；仅 enabled=true 返 true
   */
  getEnabled(id: string): boolean {
    // 扁平布局（无分片），按 id 主键 get；record 缺失 → undefined → false
    const rec = this.store.get(ConnectorConfigSchema, id);
    if (!rec) return false;
    return (rec as unknown as { enabled?: boolean }).enabled === true;
  }

  /**
   * 写 connector 的持久化 intent（upsert）。
   * @param id connector id（"browser"）
   * @param enabled switch INTENT（true=已开启）
   */
  setEnabled(id: string, enabled: boolean): void {
    // 扁平布局，put 落到 {root}/connector_config/<id>.json（FsCrudStore 内部 upsert 语义）
    this.store.put(ConnectorConfigSchema, { id, enabled } as never);
  }
}
