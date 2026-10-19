// 设置页共享分区原语（管理端 AI 设置与个人 AI 配置页共用）：
// SettingsSection = 带 h3 标题（继承页面排版）、可选描述与标题行右侧
// extra（如计数旁的操作按钮）的分区容器；SettingsField = 左侧标签
//（可选徽标 + hint 副文本）、右侧控件的行布局。样式类（.settings-section /
// .settings-field / .settings-field-label / .settings-field-control）见
// styles.css「共享设置分区原语」一节，两页共用同一份规则。
import type { ReactNode } from 'react'

/** 设置分区：标题 + 可选描述 + 标题行右侧 extra + 内容。 */
export function SettingsSection({ title, desc, extra, children }: {
  title: ReactNode
  desc?: ReactNode
  extra?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="settings-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 className="settings-section-title">{title}</h3>
        {extra}
      </div>
      {desc && <div className="hint">{desc}</div>}
      {children}
    </div>
  )
}

/** 设置行：左侧 label（含可选 badge 徽标与 hint 副文本）、右侧控件区。 */
export function SettingsField({ label, hint, badge, children }: {
  label: ReactNode
  hint?: ReactNode
  badge?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="settings-field">
      <div className="settings-field-label">
        <span>
          {label}
          {badge}
        </span>
        {hint && <span className="hint">{hint}</span>}
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  )
}
