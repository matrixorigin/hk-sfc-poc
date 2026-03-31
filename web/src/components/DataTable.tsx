import { useState, useEffect } from 'react'
import type { SQLResult } from '../types'
import { useT } from '../i18n'
import { tpl } from '../i18n'

interface DataTableProps {
  result: SQLResult
}

const PAGE_SIZE_OPTIONS = [20, 50, 100]

export function DataTable({ result }: DataTableProps) {
  const { t } = useT()
  const { columns, rows } = result

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  // Derived key for reset detection
  const resultKey = `${result.round_index}_${columns.length}_${rows.length}`

  // Reset page when result or pageSize changes
  useEffect(() => {
    setPage(1)
  }, [resultKey, pageSize])

  const totalRows = result.total_count ?? rows.length
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))

  // Defensive clamp
  const safePage = Math.min(page, totalPages)
  useEffect(() => {
    if (page !== safePage) setPage(safePage)
  }, [page, safePage])

  const start = (safePage - 1) * pageSize
  const end = Math.min(start + pageSize, rows.length)
  const displayRows = rows.slice(start, end)

  const showPagination = rows.length > pageSize

  if (!columns.length) {
    return <p style={{ color: '#94a3b8', fontSize: 13 }}>{t('noData')}</p>
  }

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
              {columns.map((_, ci) => (
                <td
                  key={ci}
                  style={{
                    maxWidth: 300,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {row[ci] === null || row[ci] === undefined ? '' : String(row[ci])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {showPagination && (
        <div className="data-table-pagination">
          <div className="pagination-size">
            <label>{t('tableRowsPerPage')}</label>
            <select
              className="page-size-select"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </div>

          <div className="pagination-nav">
            <button
              className="pagination-btn"
              disabled={safePage <= 1}
              onClick={() => setPage(1)}
              aria-label="First page"
            >
              &laquo;
            </button>
            <button
              className="pagination-btn"
              disabled={safePage <= 1}
              onClick={() => setPage(safePage - 1)}
              aria-label="Previous page"
            >
              &lsaquo;
            </button>
            <span className="pagination-indicator">
              {tpl(t('tablePageIndicator'), { page: safePage, pages: totalPages })}
            </span>
            <button
              className="pagination-btn"
              disabled={safePage >= totalPages}
              onClick={() => setPage(safePage + 1)}
              aria-label="Next page"
            >
              &rsaquo;
            </button>
            <button
              className="pagination-btn"
              disabled={safePage >= totalPages}
              onClick={() => setPage(totalPages)}
              aria-label="Last page"
            >
              &raquo;
            </button>
          </div>

          <div className="pagination-info">
            {tpl(t('tableRange'), { start: start + 1, end, total: totalRows })}
          </div>
        </div>
      )}
    </div>
  )
}
