/**
 * SkillEnabledStore —— skill enabled 状态持久化（v0.0.21）
 * 参考: specs/tech/agent/skills/[P0]skill_architecture.md §3.2
 *
 * 决策：enabled 状态落 app_config 的 `skill_state` group（key=skill name，
 * data={enabled}）。理由见 arch §3.2（集中、可热查、toggle 不写 skill 目录、
 * 复用 AppConfigService 零新依赖、fallback 默认 enabled=true）。
 *
 * fallback：group 内无某 name 的 record → 视为 enabled（新装默认开）。
 */
import type { AppConfigService } from '../config/app-config-service';

/** skill_state group 名（固定） */
const GROUP = 'skill_state';

/** skill_state record data 形态 */
export interface SkillStateRecord {
  enabled: boolean;
}

/**
 * skill enabled 状态读写器（包装 AppConfigService 的 skill_state group）。
 * 无独立存储，每次走 AppConfigService（底层 FsCrudStore 同步 IO）。
 */
export class SkillEnabledStore {
  constructor(private readonly appConfig: AppConfigService) {}

  /**
   * 取某 skill 的 enabled 状态。fallback：record 缺失 → enabled=true（新装默认开）。
   */
  isEnabled(name: string): boolean {
    const v = this.appConfig.get(GROUP, name) as SkillStateRecord | undefined;
    if (!v || typeof v.enabled !== 'boolean') return true;
    return v.enabled;
  }

  /**
   * 设置某 skill 的 enabled 状态（持久化到 app_config.skill_state）。
   */
  setEnabled(name: string, enabled: boolean): void {
    this.appConfig.set(GROUP, name, { enabled } satisfies SkillStateRecord);
  }

  /**
   * [v0.0.51] disable 语义便捷方法（skill_manage.disable 复用，spec skill_manage_tool §3）。
   * 等价于 setEnabled(name, false)；语义化命名便于工具层 caller 阅读。
   */
  disable(name: string): void {
    this.setEnabled(name, false);
  }

  /**
   * [v0.0.51] enable 语义便捷方法（skill_manage.enable 复用，spec skill_manage_tool §3）。
   * 等价于 setEnabled(name, true)。
   */
  enable(name: string): void {
    this.setEnabled(name, true);
  }
}
