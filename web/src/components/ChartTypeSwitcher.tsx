import { useT } from '../i18n'

export type ChartTypeOverride = 'line' | 'bar' | 'pie' | 'none'

interface ChartTypeSwitcherProps {
  current: ChartTypeOverride | 'auto'
  onChange: (type: ChartTypeOverride) => void
}

const OPTIONS: { key: ChartTypeOverride; labelEn: string; labelZh: string }[] = [
  { key: 'line', labelEn: 'Line', labelZh: '折线' },
  { key: 'bar', labelEn: 'Bar', labelZh: '柱状' },
  { key: 'pie', labelEn: 'Pie', labelZh: '饼图' },
  { key: 'none', labelEn: 'Hide', labelZh: '隐藏' },
]

export function ChartTypeSwitcher({ current, onChange }: ChartTypeSwitcherProps) {
  const { lang } = useT()
  return (
    <div className="chart-type-switcher">
      {OPTIONS.map((opt) => (
        <button
          key={opt.key}
          className={`chart-type-btn ${current === opt.key ? 'active' : ''}`}
          onClick={() => onChange(opt.key)}
          type="button"
        >
          {lang === 'zh' ? opt.labelZh : opt.labelEn}
        </button>
      ))}
    </div>
  )
}
