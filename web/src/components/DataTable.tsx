import { useState, useEffect, useRef, useCallback } from 'react'
import type { SQLResult } from '../types'
import { useT } from '../i18n'
import { tpl } from '../i18n'
import { apiFetch } from '../api/client'

interface DataTableProps {
  result: SQLResult
}

const PAGE_SIZE_OPTIONS = [20, 50, 100]

interface PageCache {
  [page: number]: any[][]
}

export function DataTable({ result }: DataTableProps) {
  const { t } = useT()
  const { columns, rows } = result

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [remoteRows, setRemoteRows] = useState<any[][] | null>(null)
  const [loading, setLoading] = useState(false)
  const pageCacheRef = useRef<PageCache>({})

  // Whether we need server-side pagination
  const totalRows = result.total_count ?? rows.length
  const isServerPaginated = totalRows > rows.length

  // Derived key for reset detection
  const resultKey = `${result.round_index}_${columns.length}_${rows.length}`

  // Reset page and cache when result or pageSize changes
  useEffect(() => {
    setPage(1)
    setRemoteRows(null)
    pageCacheRef.current = {}
  }, [resultKey, pageSize])

  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))

  // Defensive clamp
  const safePage = Math.min(page, totalPages)
  useEffect(() => {
    if (page !== safePage) setPage(safePage)
  }, [page, safePage])

  // Check if current page data is within the local rows range
  const start = (safePage - 1) * pageSize
  const end = Math.min(start + pageSize, totalRows)
  const localEnd = Math.min(start + pageSize, rows.length)
  const needsRemote = isServerPaginated && start >= rows.length

  // Fetch remote page data
  const fetchPage = useCallback(async (pageNum: number, size: number, sql: string) => {
    // Check cache first
    if (pageCacheRef.current[pageNum]) {
      setRemoteRows(pageCacheRef.current[pageNum])
      return
    }

    setLoading(true)
    try {
      const resp = await apiFetch('/api/query/paginate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, page: pageNum, page_size: size }),
      })
      if (!resp.ok) {
        console.error('Paginate request failed:', resp.status)
        setRemoteRows([])
        return
      }
      const data = await resp.json()
      pageCacheRef.current[pageNum] = data.rows ?? []
      setRemoteRows(data.rows ?? [])
    } catch (err) {
      console.error('Paginate request error:', err)
      setRemoteRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Trigger remote fetch when needed
  useEffect(() => {
    if (needsRemote && result.sql) {
      fetchPage(safePage, pageSize, result.sql)
    } else {
      setRemoteRows(null)
    }
  }, [needsRemote, safePage, pageSize, result.sql, fetchPage])

  // Determine which rows to display
  let displayRows: any[][]
  if (needsRemote) {
    displayRows = remoteRows ?? []
  } else {
    displayRows = rows.slice(start, localEnd)
  }

  const showPagination = totalRows > pageSize

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
          {loading ? (
            <tr>
              <td colSpan={columns.length} style={{ textAlign: 'center', padding: '20px', color: '#94a3b8' }}>
                Loading...
              </td>
            </tr>
          ) : (
            displayRows.map((row, ri) => (
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
            ))
          )}
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
              disabled={safePage <= 1 || loading}
              onClick={() => setPage(1)}
              aria-label="First page"
            >
              &laquo;
            </button>
            <button
              className="pagination-btn"
              disabled={safePage <= 1 || loading}
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
              disabled={safePage >= totalPages || loading}
              onClick={() => setPage(safePage + 1)}
              aria-label="Next page"
            >
              &rsaquo;
            </button>
            <button
              className="pagination-btn"
              disabled={safePage >= totalPages || loading}
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
