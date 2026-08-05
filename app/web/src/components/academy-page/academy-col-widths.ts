/**
 * academy-col-widths —— academy 三处可拖宽列的常量唯一权威源
 * 参考: specs/ui/components/academy-page/_overview.md §2「可拖宽列约定」表
 *
 * section 只消费本表不硬编码；key / 默认 / 上下限即用户已保存宽度的兼容契约。
 */
import type { PersistentWidthOptions } from '../common/use-persistent-width';

/**
 * 三列常量：min 取「内容仍可读」的下限，max 取「不至于挤爆对侧」的合理上限。
 */
export const ACADEMY_COL = {
  /** classroom-detail 班主任对话列（列在左，手柄贴右缘） */
  ht: { storageKey: 'academy-ht-col-width', defaultWidth: 480, minWidth: 320, maxWidth: 720 },
  /** training-observe 训练视图列（列在右，手柄贴左缘） */
  train: { storageKey: 'academy-train-col-width', defaultWidth: 520, minWidth: 380, maxWidth: 800 },
  /** version-chat 会话列表列（列在左，手柄贴右缘） */
  versionConv: { storageKey: 'academy-version-conv-width', defaultWidth: 240, minWidth: 180, maxWidth: 400 },
} as const satisfies Record<string, PersistentWidthOptions>;
