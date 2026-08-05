/**
 * section-skill-list — Skill 列表区块容器
 * 参考: specs/ui/components/skill-page/section-skill-list.md
 *       设计稿视觉基线: reqs/v0.0.21/easy-opc-skill-v10.html .skill-list/.skill-empty (:95, :103)
 *
 * 两种态：空态（虚框 + mono 文案）+ 列表态（纵向 gap-8px 多卡）。
 * loading 由父级在外包占位，本 section 不持有 loading 态。
 * 单卡交互下沉到 component-skill-item，本 section 透传回调。
 */
import type { SkillEntry } from '../../lib/api-client';
import { ComponentSkillItem } from './component-skill-item';
import { useTranslation } from 'react-i18next';

interface SectionSkillListProps {
  /** skill 列表（来自后端 GET /skill） */
  skills: SkillEntry[];
  /** 切换 enabled */
  onToggle: (name: string) => void;
  /** [v0.0.55] 切换 evolvable（调 PATCH /skill/:name/governance） */
  onToggleEvolvable: (name: string) => void;
  /** 预览 */
  onPreview: (skill: SkillEntry) => void;
  /** 删除（打开 delete modal） */
  onDelete: (skill: SkillEntry) => void;
}

/**
 * 渲染列表区。空态 .skill-empty（dashed 虚框 + mono 文案「还没有已安装的 Skill」）；
 * 列表态 flex 纵向 gap-2 多卡。
 */
export function SectionSkillList({ skills, onToggle, onToggleEvolvable, onPreview, onDelete }: SectionSkillListProps) {
  // [v0.0.62 i18n] 列表空态文案走 skill ns
  const { t } = useTranslation('skill');
  return (
    <div className="flex flex-col gap-2">
      {skills.length === 0 ? (
        <div

          className="py-7 px-0 text-center text-muted text-[13px] border border-dashed border-border rounded-[10px] font-mono"
        >
          {t('list.empty')}
        </div>
      ) : (
        skills.map((skill) => (
          <ComponentSkillItem
            key={skill.name}
            skill={skill}
            onToggle={onToggle}
            onToggleEvolvable={onToggleEvolvable}
            onPreview={onPreview}
            onDelete={onDelete}
          />
        ))
      )}
    </div>
  );
}

export default SectionSkillList;
