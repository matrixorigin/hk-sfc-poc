import type { Phase } from '../types'
import { useT } from '../i18n'

const phaseLabels: Record<string, { en: string; zh: string }> = {
  thinking:  { en: 'Understanding', zh: '理解问题' },
  planning:  { en: 'Planning',      zh: '生成方案' },
  querying:  { en: 'Querying',      zh: '查询数据' },
  answering: { en: 'Answering',     zh: '生成回答' },
}

function getLabel(phase: Phase, lang: string): string {
  return phaseLabels[phase]?.[lang as 'en' | 'zh'] ?? phase
}

export function PhasePipeline({ history, current }: { history: Phase[]; current?: Phase }) {
  const { lang } = useT()
  const completed = current ? history.slice(0, history.indexOf(current)) : history

  return (
    <div className="phase-trail">
      {history.map((phase, i) => {
        const isDone = completed.includes(phase)
        const isActive = phase === current

        return (
          <span key={`${phase}-${i}`} className="phase-trail-item" style={{ animationDelay: `${i * 60}ms` }}>
            {i > 0 && <span className="phase-trail-sep">›</span>}
            {isDone ? (
              <span className="phase-trail-done">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {getLabel(phase, lang)}
              </span>
            ) : isActive ? (
              <span className="phase-trail-active">
                <span className="phase-trail-pulse" />
                {getLabel(phase, lang)}
              </span>
            ) : (
              <span className="phase-trail-pending">{getLabel(phase, lang)}</span>
            )}
          </span>
        )
      })}
    </div>
  )
}
