/**
 * permissions 单测 —— 权限门禁纯函数（screenRecording/accessibility 按 action 分流）
 * 参考: app/server/src/tools/computer-use/permissions.ts
 *       change_plan_v2_batch2 §B2.8 A（按 action 门禁 screenRecording/accessibility）
 */
import { describe, it, expect } from 'vitest';
import { checkPermissionGate, formatPermissionMissing } from '../permissions';

describe('checkPermissionGate', () => {
  it('req screenRecording + missing → 返 screenRecording', () => {
    expect(
      checkPermissionGate({ screenRecording: true }, { accessibility: 'granted', screenRecording: 'missing' }),
    ).toBe('screenRecording');
  });
  it('req accessibility + missing → 返 accessibility（键鼠/AX action 门禁）', () => {
    expect(
      checkPermissionGate({ accessibility: true }, { accessibility: 'missing', screenRecording: 'granted' }),
    ).toBe('accessibility');
  });
  it('全满足 → null', () => {
    expect(
      checkPermissionGate({ screenRecording: true }, { accessibility: 'granted', screenRecording: 'granted' }),
    ).toBeNull();
  });
  it('未要求的权限 missing 不触发', () => {
    expect(
      checkPermissionGate({ screenRecording: true }, { accessibility: 'missing', screenRecording: 'granted' }),
    ).toBeNull();
  });
  it('accessibility 优先于 screenRecording', () => {
    expect(
      checkPermissionGate(
        { accessibility: true, screenRecording: true },
        { accessibility: 'missing', screenRecording: 'missing' },
      ),
    ).toBe('accessibility');
  });
});

describe('formatPermissionMissing', () => {
  it('screenRecording 文案含 系统设置/屏幕录制/Rocky', () => {
    const t = formatPermissionMissing('screenRecording');
    expect(t).toContain('系统设置');
    expect(t).toContain('屏幕录制');
    expect(t).toContain('Rocky');
  });
  it('accessibility 文案含 系统设置/辅助功能/Rocky', () => {
    const t = formatPermissionMissing('accessibility');
    expect(t).toContain('系统设置');
    expect(t).toContain('辅助功能');
    expect(t).toContain('Rocky');
  });
});
