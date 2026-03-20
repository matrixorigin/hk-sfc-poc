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
    return <p style={{ color: '#888', fontSize: 13 }}>{t('noData')}</p>
  }

  const displayRows = rows.slice(0, MAX_ROWS)

  return (
    <div style={{ overflowX: 'auto', marginTop: 8 }}>
      <table
        style={{
          borderCollapse: 'collapse',
          fontSize: 13,
          minWidth: '100%',
        }}
      >
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th
                key={i}
                style={{
                  padding: '6px 12px',
                  background: '#f0f0f0',
                  border: '1px solid #ddd',
                  textAlign: 'left',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, ri) => (
            <tr key={ri} style={{ background: ri % 2 === 0 ? '#fff' : '#fafafa' }}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  style={{
                    padding: '5px 12px',
                    border: '1px solid #ddd',
                    whiteSpace: 'nowrap',
                    maxWidth: 300,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
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
        <p style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
          Showing {MAX_ROWS} of {result.total_count ?? rows.length} rows
        </p>
      )}
    </div>
  )
}
