import type { SQLResult } from '../types'
import { useT } from '../i18n'

interface DataTableProps {
  result: SQLResult
}

const MAX_ROWS = 100

export function DataTable({ result }: DataTableProps) {
  const { t } = useT()
  const { columns, rows } = result

  if (!columns.length) {
    return <p style={{ color: '#94a3b8', fontSize: 13 }}>{t('noData')}</p>
  }

  const displayRows = rows.slice(0, MAX_ROWS)

  return (
    <div className="data-table-wrapper" style={{ overflowX: 'auto' }}>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th key={i}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  style={{
                    maxWidth: 300,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cell === null || cell === undefined ? '' : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_ROWS && (
        <div className="data-table-footer">
          Showing {MAX_ROWS} of {result.total_count ?? rows.length} rows
        </div>
      )}
    </div>
  )
}
