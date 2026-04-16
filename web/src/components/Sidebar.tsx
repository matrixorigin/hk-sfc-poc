import type { ConversationMeta } from '../types'
import { useT } from '../i18n'

interface SidebarProps {
  conversations: ConversationMeta[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  collapsed: boolean
  onToggle: () => void
}

export function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  collapsed,
  onToggle,
}: SidebarProps) {
  const { t } = useT()

  if (collapsed) {
    return (
      <div className="sidebar collapsed">
        <button className="sidebar-toggle" onClick={onToggle} title="Expand">
          ☰
        </button>
      </div>
    )
  }

  // 后端不存空会话前提下，直接按 updated_at DESC 显示所有
  const sorted = [...conversations].sort((a, b) => b.updated_at - a.updated_at)

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button className="sidebar-new-btn" onClick={onNew}>
          + {t('newChat')}
        </button>
        <button className="sidebar-toggle" onClick={onToggle}>
          ✕
        </button>
      </div>
      <div className="sidebar-list">
        {sorted.map((conv) => (
          <div
            key={conv.id}
            className={`sidebar-item ${conv.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(conv.id)}
          >
            <div className="sidebar-item-title">{conv.title || t('newChat')}</div>
            <div className="sidebar-item-meta">
              {new Date(conv.updated_at).toLocaleDateString()}
            </div>
            <button
              className="sidebar-item-delete"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(conv.id)
              }}
              title="Delete"
            >
              ×
            </button>
          </div>
        ))}
        {sorted.length === 0 && (
          <div className="sidebar-empty">{t('noConversations')}</div>
        )}
      </div>
    </div>
  )
}
