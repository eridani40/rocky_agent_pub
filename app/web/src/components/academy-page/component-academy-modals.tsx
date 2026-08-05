/**
 * component-academy-modals —— 版本内容编辑弹层挂载层（md 编辑器 + skill browser）
 * 参考: specs/ui/components/academy-page/component-modal-md-editor.md
 *       specs/ui/components/academy-page/component-skill-browser-modal.md
 *       specs/ui/overall/12-academy.md §8 / §8.1（两条通道的字段边界）
 *
 * 从 page-academy 拆出（保 page ≤300 行）：只负责「两个版本内容弹层的挂载 + 保存通道接线」，
 * modal 的开关 state 仍归 page（本组件按 target 是否为空渲染），符合「modal 由 page 顶层挂载」。
 *
 * 两条通道彻底分开，互不相通：
 *   - md 编辑器：saveKind 只有 'agentsMd' | 'tools' → PATCH 版本内容（§1.9）
 *   - skill browser：单文件读/写 → GET/PATCH .../skill/:name/file（§1.11）
 * **MUST NOT 新增 saveKind='skillFile'**：Skills 一旦回到 md 编辑器通道，保存就会把
 * skill 数据经 agentsMd 全量覆盖 AGENTS.md（历史数据丢失形态，现按构造消失）。
 */
import { useCallback } from 'react';
import { getVersionSkillFile, patchVersion, saveVersionSkillFile } from '../../lib/academy-api';
import { ComponentModalMdEditor } from '../common/component-modal-md-editor';
import { ComponentSkillBrowserModal } from './component-skill-browser-modal';
import type { MdEditorTarget, SkillBrowserTarget } from './section-student-detail';

interface Props {
  classroomId: string;
  studentId: string;
  studentName: string;
  /** md 编辑器目标（null = 不渲染） */
  mdEditor: MdEditorTarget | null;
  /** skill browser 目标（null = 不渲染） */
  skillBrowser: SkillBrowserTarget | null;
  onCloseMdEditor: () => void;
  onCloseSkillBrowser: () => void;
  /** 任一保存成功后刷新版本内容（文件树 hash 随之更新） */
  onSaved: () => void;
}

/** 版本内容弹层挂载层 */
export function ComponentAcademyModals({
  classroomId, studentId, studentName, mdEditor, skillBrowser, onCloseMdEditor, onCloseSkillBrowser, onSaved,
}: Props) {
  /** md 编辑器保存：tools 走 versionJson.tools（换行分隔），其余走 agentsMd */
  const handleMdSave = useCallback(async (target: MdEditorTarget, newValue: string) => {
    if (target.saveKind === 'tools') {
      const tools = newValue.split('\n').map((s) => s.trim()).filter(Boolean);
      await patchVersion(classroomId, studentId, target.versionId, { versionJson: { tools } });
    } else {
      await patchVersion(classroomId, studentId, target.versionId, { agentsMd: newValue });
    }
    onSaved();
  }, [classroomId, studentId, onSaved]);

  /** skill 单文件保存（绝不经 patchVersion —— 那会全量重写 AGENTS.md + version.json） */
  const handleSkillFileSave = useCallback(async (
    versionId: string,
    args: { skillName: string; path: string; content: string },
  ) => {
    await saveVersionSkillFile(classroomId, studentId, versionId, args.skillName, args.path, args.content);
    onSaved();
  }, [classroomId, studentId, onSaved]);

  return (
    <>
      {/* md 编辑弹层（AGENTS.md / tools） */}
      {mdEditor && (
        <ComponentModalMdEditor
          open
          fileName={mdEditor.fileName}
          subtitle={mdEditor.subtitle}
          initialValue={mdEditor.value}
          versionLabel={mdEditor.versionLabel}
          readOnly={mdEditor.readOnly}
          onSave={(v) => handleMdSave(mdEditor, v)}
          onClose={onCloseMdEditor}
        />
      )}

      {/* Skills 浏览/编辑弹层（目录 + 文件树 → 单文件读写） */}
      {skillBrowser && (
        <ComponentSkillBrowserModal
          open
          skills={skillBrowser.skills}
          studentName={studentName}
          versionLabel={skillBrowser.versionLabel}
          readOnly={skillBrowser.readOnly}
          onFetchFile={(skillName, path) =>
            getVersionSkillFile(classroomId, studentId, skillBrowser.versionId, skillName, path)
          }
          onSaveFile={skillBrowser.readOnly ? undefined : (args) => handleSkillFileSave(skillBrowser.versionId, args)}
          onClose={onCloseSkillBrowser}
        />
      )}
    </>
  );
}

export default ComponentAcademyModals;
