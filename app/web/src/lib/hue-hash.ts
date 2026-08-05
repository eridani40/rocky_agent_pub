/**
 * hue-hash —— 8 色 hue palette 稳定 hash 单例（INV-5）
 * 参考: specs/ui/regulation/01-tokens.md §1.7（8 色 palette 顺序权威源）
 *       specs/ui/regulation/03-principles.md §2（彩虹色分配规则）
 *       specs/tech/version_logs/v0.0.165/change_plan.md §4/§7（本文件 = member-avatar / icon-box 共用单例）
 *
 * 职责：
 *   - HUE_PALETTE = 8 色调色板名字（顺序与 regulation 01 §1.7 表严格一致，vision compare 依赖 index→hex 稳定）
 *   - hashHueIndex(id) = 稳定 hash（djb2 → uint32 → %8），同 id 恒返同 index
 *   - hashHueName(id) = 语法糖，`HUE_PALETTE[hashHueIndex(id)]`
 *
 * 消费方：`components/common/member-avatar.tsx`（member/user/squad 头像）
 *         `components/common/component-icon-box.tsx`（skill / plugin / model / provider 图标底）
 *         其他需要「同一 id 恒同色」的身份识别场景
 *
 * 设计原则：
 *   - 纯函数、无副作用、无外部依赖（不引 crypto/hash 库）
 *   - INV-5 单一 hash 实现：全站只此一处，禁止重复实现（tests/skill-item 等复用 IconBox 派生）
 *   - hash 稳定性：`hashHueIndex('member-123') === hashHueIndex('member-123')` 恒真
 */

/**
 * 8 色 palette 名（顺序与 regulation 01 §1.7 表严格对齐，改序会破坏历史 id→色映射）
 * 每个名字对应 tokens.css 的 `--hue-{name}`（主色）+ `--hue-{name}-bg`（浅底）
 */
export const HUE_PALETTE = [
  'rose', // 0
  'orange', // 1
  'amber', // 2
  'green', // 3
  'teal', // 4
  'blue', // 5
  'violet', // 6
  'pink', // 7
] as const;

export type HuePaletteName = (typeof HUE_PALETTE)[number];

/**
 * 稳定 hash：给定 id 返回 [0, 8) 的 palette index。
 * 算法 = djb2（Dan Bernstein hash）：`hash = hash*33 + c`，用 `| 0` 截 32 位有符号整型；
 * 用 `>>> 0` 前置转 uint32 再 %8，避免负数索引。
 *
 * 属性：
 *   - 稳定：同 id 每次调用返同一 index
 *   - 快：O(n)，n=id 长度，纯 ASCII/Unicode charCode 累加
 *   - 分布：常规业务 id（ulid / uuid / name+timestamp）分布近似均匀（详见 UT 分布断言）
 *   - 无碰撞保证：8 桶必有碰撞，用于「视觉分色」而非「唯一识别」
 *
 * 空串兜底：返回 0（rose），避免除零；调用方通常传 id ?? name，name 也可空 → 落 rose。
 */
export function hashHueIndex(id: string): number {
  if (!id) return 0;
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    // hash * 33 + c，`| 0` 截 32 位有符号整数保持等价 C 实现
    hash = ((hash << 5) + hash + id.charCodeAt(i)) | 0;
  }
  // `>>> 0` 转 uint32 再 mod，避免负数索引
  return (hash >>> 0) % HUE_PALETTE.length;
}

/**
 * 语法糖：直接返 palette 名（如 'rose' / 'blue'）供消费方拼 CSS 变量。
 * 用例：`style={{ background: `var(--hue-${hashHueName(id)}-bg)` }}`
 *
 * 实现：`hashHueIndex` 保证返 [0, 8)，`HUE_PALETTE` 长度恒 8，直接索引必非空；
 * tsc `noUncheckedIndexedAccess` 无法在类型层证明，故 `??` 兜底到 'rose'（永不触发）。
 */
export function hashHueName(id: string): HuePaletteName {
  return HUE_PALETTE[hashHueIndex(id)] ?? 'rose';
}
