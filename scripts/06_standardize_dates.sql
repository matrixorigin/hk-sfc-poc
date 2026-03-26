-- HK SFC POC - 日期标准化
-- 给三张非标日期表添加标准 DATE 列，便于 LLM 生成正确的日期查询
--
-- ms_t_stk_hsi.HSTXDT: '02JAN2025:09:20:00' → trade_date DATE
-- ms_t_stk_sis.SITXDT: '02JAN2025:00:00:00' → trade_date DATE
-- ms_v_stock_capital.SIRXDT: '31-JAN-25' → ref_date DATE

-- ============================================================
-- 1. ms_t_stk_hsi: 添加 trade_date
-- ============================================================
ALTER TABLE ms_t_stk_hsi ADD COLUMN trade_date DATE COMMENT 'Trading date (standardized from HSTXDT). Use this column for date filtering and comparison.';

UPDATE ms_t_stk_hsi SET trade_date = CAST(
  CONCAT(
    SUBSTR(HSTXDT, 6, 4), '-',
    CASE SUBSTR(HSTXDT, 3, 3)
      WHEN 'JAN' THEN '01' WHEN 'FEB' THEN '02' WHEN 'MAR' THEN '03'
      WHEN 'APR' THEN '04' WHEN 'MAY' THEN '05' WHEN 'JUN' THEN '06'
      WHEN 'JUL' THEN '07' WHEN 'AUG' THEN '08' WHEN 'SEP' THEN '09'
      WHEN 'OCT' THEN '10' WHEN 'NOV' THEN '11' WHEN 'DEC' THEN '12'
    END, '-',
    SUBSTR(HSTXDT, 1, 2)
  ) AS DATE
);

-- ============================================================
-- 2. ms_t_stk_sis: 添加 trade_date
-- ============================================================
ALTER TABLE ms_t_stk_sis ADD COLUMN trade_date DATE COMMENT 'Trading date (standardized from SITXDT). Use this column for date filtering, JOIN, and window functions.';

UPDATE ms_t_stk_sis SET trade_date = CAST(
  CONCAT(
    SUBSTR(SITXDT, 6, 4), '-',
    CASE SUBSTR(SITXDT, 3, 3)
      WHEN 'JAN' THEN '01' WHEN 'FEB' THEN '02' WHEN 'MAR' THEN '03'
      WHEN 'APR' THEN '04' WHEN 'MAY' THEN '05' WHEN 'JUN' THEN '06'
      WHEN 'JUL' THEN '07' WHEN 'AUG' THEN '08' WHEN 'SEP' THEN '09'
      WHEN 'OCT' THEN '10' WHEN 'NOV' THEN '11' WHEN 'DEC' THEN '12'
    END, '-',
    SUBSTR(SITXDT, 1, 2)
  ) AS DATE
);

-- ============================================================
-- 3. ms_v_stock_capital: 添加 ref_date
--    SIRXDT 格式: '31-JAN-25' → '2025-01-31'
-- ============================================================
ALTER TABLE ms_v_stock_capital ADD COLUMN ref_date DATE COMMENT 'Month-end reference date (standardized from SIRXDT). Use this column for date filtering and comparison.';

UPDATE ms_v_stock_capital SET ref_date = CAST(
  CONCAT(
    '20', SUBSTR(SIRXDT, 8, 2), '-',
    CASE SUBSTR(SIRXDT, 4, 3)
      WHEN 'JAN' THEN '01' WHEN 'FEB' THEN '02' WHEN 'MAR' THEN '03'
      WHEN 'APR' THEN '04' WHEN 'MAY' THEN '05' WHEN 'JUN' THEN '06'
      WHEN 'JUL' THEN '07' WHEN 'AUG' THEN '08' WHEN 'SEP' THEN '09'
      WHEN 'OCT' THEN '10' WHEN 'NOV' THEN '11' WHEN 'DEC' THEN '12'
    END, '-',
    SUBSTR(SIRXDT, 1, 2)
  ) AS DATE
);
