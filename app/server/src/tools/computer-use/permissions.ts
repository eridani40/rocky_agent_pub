/**
 * computer-use 权限门禁 —— 纯函数（tool 门禁消费，无副作用）
 * 参考: specs/tech/version_logs/v0.0.105/change_plan_v2.md §5 P0-D permissions.ts
 *
 * 职责：screenshot 等 computer tool 运行前，按 requirement 校验 port.checkPermissions() 结果，
 *   缺权限返 missing 名（不抛），tool 转 formatPermissionMissing 引导文案 errorResult。
 *   截图仅需 screenRecording；第二批键鼠/AX 需 accessibility。
 */
import type { ComputerPermissions } from '../../platform/computer/native-port';

/** 单 tool 的权限要求（按需勾选；截图 = {screenRecording:true}） */
export interface PermissionRequirement {
  accessibility?: boolean;
  screenRecording?: boolean;
}

/**
 * 权限门禁：按 requirement 校验 perms，返第一个缺失的权限名，全满足返 null。
 * accessibility 优先于 screenRecording（第二批键鼠先于截图；本批只查 screenRecording）。
 *
 * @param req   本 tool 要求的权限（缺省字段视为不要求）
 * @param perms port.checkPermissions() 结果
 * @returns 缺失权限名（'accessibility'|'screenRecording'）或 null（全满足）
 */
export function checkPermissionGate(
  req: PermissionRequirement,
  perms: ComputerPermissions,
): 'accessibility' | 'screenRecording' | null {
  if (req.accessibility && perms.accessibility === 'missing') return 'accessibility';
  if (req.screenRecording && perms.screenRecording === 'missing') return 'screenRecording';
  return null;
}

/**
 * 生成面向 LLM 的权限引导文案（含「系统设置」「屏幕录制」/「辅助功能」「Rocky」关键词）。
 * 屏幕录制授权 macOS 不支持程序弹窗，只能引导用户手动去系统设置勾选后重启 Rocky。
 *
 * @param which 缺失的权限名
 * @returns 引导文案（tool 作为 errorResult 的 text 回灌 LLM）
 */
export function formatPermissionMissing(which: 'accessibility' | 'screenRecording'): string {
  if (which === 'screenRecording') {
    return (
      'computer use 缺少「屏幕录制」系统权限，无法截图。' +
      '请在 macOS「系统设置 → 隐私与安全性 → 屏幕录制」中勾选 Rocky，' +
      '然后完全退出并重启 Rocky 后重试（屏幕录制权限需重启生效）。'
    );
  }
  return (
    'computer use 缺少「辅助功能」系统权限，无法控制键鼠。' +
    '请在 macOS「系统设置 → 隐私与安全性 → 辅助功能」中勾选 Rocky，然后重试。'
  );
}
