import type { Language, MetricExplainItem } from '../types'

type MetricText = Pick<MetricExplainItem, 'name' | 'explain' | 'code'>

const EN_METRICS: Record<string, MetricText> = {
  'ms_t_stk_sis.trade_date': {
    name: 'Stock Trading Date',
    explain:
      'The raw date is stored as text, for example 02JAN2025:00:00:00. It cannot be compared or filtered as a date directly. During import, it is parsed into a standard date and stored in this column. Use this column for date filters, joins, and sorting.',
    code: `-- MatrixOne does not support STR_TO_DATE; rebuild the date with SUBSTR
UPDATE ms_t_stk_sis SET trade_date = CAST(CONCAT(
    SUBSTR(SITXDT, 6, 4), '-',
    CASE SUBSTR(SITXDT, 3, 3)
      WHEN 'JAN' THEN '01' WHEN 'FEB' THEN '02' WHEN 'MAR' THEN '03'
      WHEN 'APR' THEN '04' WHEN 'MAY' THEN '05' WHEN 'JUN' THEN '06'
      WHEN 'JUL' THEN '07' WHEN 'AUG' THEN '08' WHEN 'SEP' THEN '09'
      WHEN 'OCT' THEN '10' WHEN 'NOV' THEN '11' WHEN 'DEC' THEN '12'
    END, '-',
    SUBSTR(SITXDT, 1, 2)
) AS DATE)`,
  },
  'ms_t_stk_hsi.trade_date': {
    name: 'HSI Trading Date',
    explain:
      'The raw Hang Seng Index date is also stored as text. During import, it is parsed into a standard date and stored in this column. It uses the same logic as the stock trading date and should be used the same way.',
    code: `UPDATE ms_t_stk_hsi SET trade_date = CAST(CONCAT(
    SUBSTR(HSTXDT, 6, 4), '-',
    CASE SUBSTR(HSTXDT, 3, 3)
      WHEN 'JAN' THEN '01' ... WHEN 'DEC' THEN '12'
    END, '-',
    SUBSTR(HSTXDT, 1, 2)
) AS DATE)`,
  },
  'ms_v_stk_hsi_daily.trade_date': {
    name: 'HSI Daily Trading Date',
    explain:
      'The HSI daily table is a daily snapshot derived from the raw Hang Seng Index quote table. It keeps one row per trading day, using the parsed trading date from the raw HSI data. Queries for a day, month, or date range of HSI daily data use this table directly.',
    code: `CREATE TABLE ms_v_stk_hsi_daily AS
SELECT trade_date, HSHSI, HSFIN, HSUTL, HSPROP, HSCANI,
       (HSHSI - LAG(HSHSI) OVER (ORDER BY trade_date))
       / LAG(HSHSI) OVER (ORDER BY trade_date) * 100 AS hsi_pct_change
FROM ms_t_stk_hsi
WHERE CLOSING = 9
ORDER BY trade_date`,
  },
  'ms_v_stk_hsi_daily.HSHSI': {
    name: 'HSI Daily Close',
    explain:
      'This column comes from the daily closing record in the raw Hang Seng Index quote table. Import first parses the raw HSI quote date into a trading date, then keeps daily closing records to build a one-row-per-day HSI daily table for direct index queries.',
    code: `CREATE TABLE ms_v_stk_hsi_daily AS
SELECT trade_date, HSHSI, HSFIN, HSUTL, HSPROP, HSCANI,
       (HSHSI - LAG(HSHSI) OVER (ORDER BY trade_date))
       / LAG(HSHSI) OVER (ORDER BY trade_date) * 100 AS hsi_pct_change
FROM ms_t_stk_hsi
WHERE CLOSING = 9
ORDER BY trade_date`,
  },
  'ms_v_stk_hsi_daily.hsi_pct_change': {
    name: 'HSI Daily Percent Change',
    explain:
      'In the HSI daily table, this calculates each trading day close relative to the previous trading day close. Negative values mean a decline, for example -2.5 means the index fell 2.5% from the previous trading day. This supports filters such as days when HSI dropped more than 2%.',
    code: `(HSHSI - LAG(HSHSI) OVER (ORDER BY trade_date))
/ LAG(HSHSI) OVER (ORDER BY trade_date) * 100 AS hsi_pct_change`,
  },
  'sehknews.trade_date': {
    name: 'Announcement Impact Trading Date',
    explain:
      'This maps an announcement timestamp to the trading day it can affect. Announcements before 16:00 count for the same day; announcements after 16:00 or on non-trading days roll forward to the next market-open trading day. This keeps announcements aligned with stock prices around holidays and after-market releases.',
    code: `-- 1) Convert timestamp to effective_date (after market close +1 day)
-- 2) Find the earliest ms_t_stk_sis trade_date >= effective_date
UPDATE sehknews n
JOIN (
  SELECT effective_date, MIN(trade_date) AS trade_date
  FROM (SELECT nd.effective_date, td.trade_date
        FROM (... CASE WHEN HOUR(timestamp) >= 16
                       THEN DATE_ADD(DATE(timestamp), INTERVAL 1 DAY)
                       ELSE DATE(timestamp) END AS effective_date ...) nd
        JOIN (SELECT DISTINCT trade_date FROM ms_t_stk_sis) td
          ON td.trade_date >= nd.effective_date) x
  GROUP BY effective_date
) mapping ON n.effective_date = mapping.effective_date
SET n.trade_date = mapping.trade_date`,
  },
  'ms_v_stock_capital.industry_name': {
    name: 'Industry Classification (strict as-of forward fill)',
    explain:
      'The raw industry classification data records a row only when a classification changes, while market-cap data is stored as month-end snapshots. This column pre-aligns each stock to its most recent industry classification as of each month end. If no classification existed before that month end, it remains empty and does not backfill from the future.',
    code: `# Python: group by stock, sort by date, then perform an as-of join for each month end
cls = {}  # stock_code -> [(modified_date, industry_name), ...]
for row in ds_t_int_hsicl_dtl:
    cls.setdefault(row.STKCD, []).append((row.MODIFIED_DATE, row.industry_name))

for stock_code, history in cls.items():
    history.sort()
    for month_end in month_ends:
        latest = max((d for d in history if d[0] <= month_end),
                     key=lambda x: x[0], default=None)
        if latest:
            yield (stock_code, month_end, latest[1])`,
  },
  'ms_t_stk_sis.ma_3': {
    name: '3-Day Moving Average',
    explain:
      'The simple average of the closing prices over the most recent 3 trading days. It is empty when there are fewer than 3 available trading days, for example shortly after a stock is listed.',
    code: `class RollingAvg:
    def __init__(self, w): self.w=w; self.buf=deque(); self.s=0.0; self.c=0
    def add(self, v):
        if len(self.buf) >= self.w:
            old = self.buf.popleft()
            if old is not None: self.s -= old; self.c -= 1
        self.buf.append(v)
        if v is not None: self.s += v; self.c += 1
    def avg(self):
        return self.s/self.c if len(self.buf) >= self.w and self.c else None

r3 = RollingAvg(3)
r3.add(close)
ma3 = round(r3.avg(), 4) if r3.avg() is not None else None`,
  },
  'ms_t_stk_sis.ma_20': {
    name: '20-Day Moving Average',
    explain: 'The simple average of the closing prices over the most recent 20 trading days. It is empty when there are fewer than 20 available trading days.',
    code: `r20 = RollingAvg(20)
r20.add(close)
ma20 = round(r20.avg(), 4) if r20.avg() is not None else None`,
  },
  'ms_t_stk_sis.ma_50': {
    name: '50-Day Moving Average',
    explain: 'The simple average of the closing prices over the most recent 50 trading days. It is empty when there are fewer than 50 available trading days.',
    code: `r50 = RollingAvg(50)
r50.add(close)
ma50 = round(r50.avg(), 4) if r50.avg() is not None else None`,
  },
  'ms_t_stk_sis.ma_100': {
    name: '100-Day Moving Average',
    explain: 'The simple average of the closing prices over the most recent 100 trading days. It is empty when there are fewer than 100 available trading days.',
    code: `r100 = RollingAvg(100)
r100.add(close)
ma100 = round(r100.avg(), 4) if r100.avg() is not None else None`,
  },
  'ms_t_stk_sis.consecutive_above_ma3': {
    name: 'Consecutive Days Above MA3',
    explain:
      'As of the current day, this is the number of consecutive days where the close is above the 3-day moving average, including the current day. The count resets to zero when the close falls to or below the 3-day moving average.',
    code: `# Scan row by row; reset when the stock changes
if ma3 is not None and close is not None and close > ma3:
    if streak3 == 0:
        start3 = date              # record the start date
    streak3 += 1
else:
    streak3 = 0
    start3 = None`,
  },
  'ms_t_stk_sis.consecutive_above_ma3_start': {
    name: 'Start Date of Consecutive Days Above MA3',
    explain:
      'The start date of the current run where the close is consecutively above the 3-day moving average. Use it together with consecutive days above MA3 to locate the beginning of the streak.',
    code: `if streak3 == 0:
    start3 = date     # record when a new streak starts
# when the streak breaks, start3 = None`,
  },
  'ms_t_stk_sis.consecutive_above_ma20': {
    name: 'Consecutive Days Above MA20',
    explain:
      'As of the current day, this is the number of consecutive days where the close is above the 20-day moving average, including the current day. The count resets to zero when the close falls to or below the 20-day moving average.',
    code: `if ma20 is not None and close is not None and close > ma20:
    if streak20 == 0: start20 = date
    streak20 += 1
else:
    streak20 = 0; start20 = None`,
  },
  'ms_t_stk_sis.consecutive_above_ma20_start': {
    name: 'Start Date of Consecutive Days Above MA20',
    explain: 'The start date of the current run where the close is consecutively above the 20-day moving average.',
    code: `if streak20 == 0:
    start20 = date`,
  },
  'ms_t_stk_sis.consecutive_above_ma50': {
    name: 'Consecutive Days Above MA50',
    explain:
      'As of the current day, this is the number of consecutive days where the close is above the 50-day moving average, including the current day. The count resets to zero when the close falls to or below the 50-day moving average.',
    code: `if ma50 is not None and close is not None and close > ma50:
    if streak50 == 0: start50 = date
    streak50 += 1
else:
    streak50 = 0; start50 = None`,
  },
  'ms_t_stk_sis.consecutive_above_ma50_start': {
    name: 'Start Date of Consecutive Days Above MA50',
    explain: 'The start date of the current run where the close is consecutively above the 50-day moving average.',
    code: `if streak50 == 0:
    start50 = date`,
  },
  'ms_t_stk_sis.avg_vol_30d': {
    name: '30-Day Average Trading Volume',
    explain:
      'The average trading volume over the most recent 30 trading days before the current day, excluding the current day to avoid using future information. If fewer than 20 valid observations exist in that window, the value is empty. It is commonly used to detect abnormal volume, for example when current volume is more than 3 times this value. This corresponds to the client definition Avg_Vol_30_Pre.',
    code: `# Calculate avg_vol from the existing buffer first, excluding the current day
if vol_count >= 20:
    avg_vol = vol_sum / vol_count
else:
    avg_vol = None

# Push the current day's volume after calculation to preserve shift(1) semantics
vol_buf.append(vol)
if vol is not None:
    vol_sum += vol; vol_count += 1
if len(vol_buf) > 30:
    old = vol_buf.popleft()
    if old is not None:
        vol_sum -= old; vol_count -= 1`,
  },
}

export function localizeMetric(item: MetricExplainItem, lang: Language): MetricExplainItem {
  if (lang !== 'en') return item
  const translated = EN_METRICS[item.column]
  if (!translated) return item
  return { ...item, ...translated }
}
