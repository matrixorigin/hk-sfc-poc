import { useEffect } from 'react'
import { useT } from '../i18n'
import './GuidePanel.css'

interface GuidePanelProps {
  open: boolean
  onClose: () => void
}

export function GuidePanel({ open, onClose }: GuidePanelProps) {
  const { lang, t } = useT()

  useEffect(() => {
    if (!open) return

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div className="guide-panel-overlay" onClick={onClose} />
      <section
        className="guide-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-panel-title"
      >
        <div className="guide-panel-header">
          <div>
            <h2 id="guide-panel-title">{t('guide')}</h2>
            <p>{t('guideDesc')}</p>
          </div>
          <button
            className="guide-panel-close"
            type="button"
            onClick={onClose}
            aria-label={t('close')}
          >
            ×
          </button>
        </div>

        <iframe
          className="guide-panel-frame"
          src={`/guide.html?lang=${lang}&embed=1`}
          title={t('guide')}
        />
      </section>
    </>
  )
}
