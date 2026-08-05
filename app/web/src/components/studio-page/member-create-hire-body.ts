/**
 * member-create-hire-body —— MemberCreate 表单态 → HireMemberBody 组装（三模式分支收敛）
 * 参考: specs/api/overall/11a-squad-endpoints.md §2.1（hire body 语义）
 *       specs/api/overall/18-academy.md §5.1（derive_academy）
 * 从 section-member-create 拆出（保 section ≤300 行）；纯函数可单测。
 */
import type { HireMemberBody, MemberSkillConfig } from './squad-types';
import type { SkillFilterEntry } from './component-member-skill-filter';
import type { DeriveAcademySelection } from './section-member-create-derive-academy';

/** 表单态 → HireMemberBody（三模式分支收敛；抽自保 section ≤300 行） */
export function buildHireBody(input: {
  mode: 'fresh' | 'derive' | 'derive_academy';
  name: string;
  intro: string;
  workStyle: string;
  skillMode: 'inherit' | 'custom';
  catalog: SkillFilterEntry[];
  overrides: Record<string, boolean>;
  deriveFrom: string;
  academySel: DeriveAcademySelection | null;
}): HireMemberBody {
  const { mode, name, intro, workStyle, skillMode, catalog, overrides, deriveFrom, academySel } = input;
  if (mode === 'fresh') {
    // workStyle 可空：trim 后非空才传（创建页无「清空」语义，字段初始即空）
    const ws = workStyle.trim();
    // skills：off=inherit 不传 skillConfig（后端缺省即 inherit，对齐编辑页 R6）；
    //   on=custom 传 R5 全量快照（筛选器每行当前 on/off）
    let skillConfig: MemberSkillConfig | undefined;
    if (skillMode === 'custom') {
      const snap: Record<string, boolean> = {};
      for (const e of catalog) snap[e.name] = overrides[e.name] ?? e.enabled;
      skillConfig = { mode: 'custom', overrides: snap };
    }
    return {
      mode: 'fresh',
      name: name.trim(),
      intro: intro.trim(),
      ...(ws ? { workStyle: ws } : {}),
      ...(skillConfig ? { skillConfig } : {}),
    };
  }
  if (mode === 'derive') {
    // derive：留空 = 继承父（workStyle 默认复制父，11a §2.1）；仅非空 trim 字段进 overrides
    const ov: { name?: string; intro?: string; workStyle?: string } = {};
    if (name.trim()) ov.name = name.trim();
    if (intro.trim()) ov.intro = intro.trim();
    if (workStyle.trim()) ov.workStyle = workStyle.trim();
    return {
      mode: 'derive',
      deriveFrom,
      ...(Object.keys(ov).length ? { overrides: ov } : {}),
    };
  }
  // derive_academy（18-academy.md §5.1）：name = 学生名自动带上；intro/workStyle 可选手填
  //   [v0.0.233] resolution（同名裁决）透传——前端预览面板同名项 toggle 产出；undefined = 后端默认全 skip
  return {
    mode: 'derive_academy',
    name: academySel!.name,
    academySource: academySel!.academySource,
    ...(intro.trim() ? { intro: intro.trim() } : {}),
    ...(workStyle.trim() ? { workStyle: workStyle.trim() } : {}),
    ...(academySel!.resolution ? { resolution: academySel!.resolution } : {}),
  };
}
