import type { Conversation } from '../types'
import { useT } from '../i18n'

interface SidebarProps {
  conversations: Conversation[]
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

  // 只显示有消息的会话，过滤掉空会话
  const sorted = [...conversations]
    .filter((c) => c.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)

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
              {new Date(conv.updatedAt).toLocaleDateString()}
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
