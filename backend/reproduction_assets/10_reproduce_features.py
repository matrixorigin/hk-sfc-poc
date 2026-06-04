#!/usr/bin/env python3
"""
Reproduce HK_POC precomputed features from base tables.

The script covers every transformation currently exposed in backend/metrics.yaml:
- trade_date parsing for ms_t_stk_hsi and ms_t_stk_sis
- ref_date parsing for ms_v_stock_capital
- sehknews.trade_date impact trading-day mapping
- ms_v_stock_capital.industry_name strict as-of fill
- ms_t_stk_sis moving averages, consecutive-above-MA streaks, and avg_vol_30d
- ms_v_stk_hsi_daily daily close and hsi_pct_change

Default mode is run: verify transformations, then execute query.sql and write result.csv.
export and verify do not modify database tables. apply updates the target precomputed
columns and requires --yes.
"""

from __future__ import annotations

import argparse
import csv
import os
import random
import subprocess
import sys
import tempfile
from bisect import bisect_right
from collections import deque
from pathlib import Path
from typing import Iterable, Optional


MONTH_CASE = (
    "CASE SUBSTR({field}, {month_pos}, 3) "
    "WHEN 'JAN' THEN '01' WHEN 'FEB' THEN '02' WHEN 'MAR' THEN '03' "
    "WHEN 'APR' THEN '04' WHEN 'MAY' THEN '05' WHEN 'JUN' THEN '06' "
    "WHEN 'JUL' THEN '07' WHEN 'AUG' THEN '08' WHEN 'SEP' THEN '09' "
    "WHEN 'OCT' THEN '10' WHEN 'NOV' THEN '11' WHEN 'DEC' THEN '12' END"
)


class MySQL:
    def __init__(self, args: argparse.Namespace):
        self.host = args.host or os.getenv("MO_HOST", "127.0.0.1")
        self.port = str(args.port or os.getenv("MO_PORT", "6001"))
        self.user = args.user or os.getenv("MO_USER") or os.getenv("MYSQL_USER")
        self.password = args.password if args.password is not None else (
            os.getenv("MO_PASSWORD") or os.getenv("MYSQL_PWD") or ""
        )
        self.database = args.database or os.getenv("MO_DB") or os.getenv("MYSQL_DATABASE")
        self.mysql_bin = args.mysql_bin or os.getenv("MYSQL_BIN", "mysql")

        if not self.user:
            raise SystemExit("missing database user: pass --user or set MO_USER")
        if not self.database:
            raise SystemExit("missing database name: pass --database or set MO_DB")

    def base_cmd(self, *, headers: bool = False) -> list[str]:
        cmd = [
            self.mysql_bin,
            "--batch",
            "--raw",
            "--local-infile=1",
            "-h",
            self.host,
            "-P",
            self.port,
            "-u",
            self.user,
        ]
        cmd.append("--column-names" if headers else "--skip-column-names")
        cmd.append(self.database)
        return cmd

    def run(
        self,
        sql: str,
        *,
        headers: bool = False,
        output: Optional[Path] = None,
        capture: bool = False,
    ) -> str:
        env = os.environ.copy()
        env["MYSQL_PWD"] = self.password
        proc = subprocess.run(
            self.base_cmd(headers=headers),
            input=sql,
            text=True,
            stdout=subprocess.PIPE if capture or output else None,
            stderr=subprocess.PIPE,
            env=env,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"mysql failed ({proc.returncode}): {proc.stderr.strip()}\nSQL:\n{sql}")
        if output:
            output.write_text(proc.stdout, encoding="utf-8")
        return proc.stdout if capture else ""


def parse_trade_date_expr(field: str, month_pos: int, year_expr: str) -> str:
    month = MONTH_CASE.format(field=field, month_pos=month_pos)
    return f"CAST(CONCAT({year_expr}, '-', {month}, '-', SUBSTR({field}, 1, 2)) AS DATE)"


def hsi_trade_date_expr() -> str:
    return parse_trade_date_expr("HSTXDT", 3, "SUBSTR(HSTXDT, 6, 4)")


def sis_trade_date_expr() -> str:
    return parse_trade_date_expr("SITXDT", 3, "SUBSTR(SITXDT, 6, 4)")


def cap_ref_date_expr() -> str:
    return parse_trade_date_expr("SIRXDT", 4, "CONCAT('20', SUBSTR(SIRXDT, 8, 2))")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def sql_literal_path(path: Path) -> str:
    return str(path.resolve()).replace("\\", "\\\\").replace("'", "''")


def query_to_tsv(mysql: MySQL, sql: str, output: Path, *, headers: bool = True) -> None:
    mysql.run(sql, headers=headers, output=output)
    print(f"wrote {output}")


def query_to_csv(mysql: MySQL, sql: str, output: Path) -> None:
    data = mysql.run(sql, headers=True, capture=True)
    rows = csv.reader(data.splitlines(), delimiter="\t")
    with output.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        for row in rows:
            writer.writerow(row)
    print(f"wrote {output}")


def export_sql_features(mysql: MySQL, output_dir: Path) -> None:
    query_to_tsv(
        mysql,
        f"""
SELECT HSTXDT, {hsi_trade_date_expr()} AS computed_trade_date
FROM ms_t_stk_hsi
ORDER BY HSTXDT;
""",
        output_dir / "ms_t_stk_hsi.trade_date.tsv",
    )
    query_to_tsv(
        mysql,
        f"""
SELECT SISTKC, SITXDT, {sis_trade_date_expr()} AS computed_trade_date
FROM ms_t_stk_sis
ORDER BY SISTKC, SITXDT;
""",
        output_dir / "ms_t_stk_sis.trade_date.tsv",
    )
    query_to_tsv(
        mysql,
        f"""
SELECT STKCD, SIRXDT, {cap_ref_date_expr()} AS computed_ref_date
FROM ms_v_stock_capital
ORDER BY STKCD, SIRXDT;
""",
        output_dir / "ms_v_stock_capital.ref_date.tsv",
    )

    query_to_tsv(
        mysql,
        """
SELECT n.securitycode,
       n.`timestamp`,
       CASE WHEN HOUR(n.`timestamp`) >= 16
            THEN DATE_ADD(DATE(n.`timestamp`), INTERVAL 1 DAY)
            ELSE DATE(n.`timestamp`)
       END AS effective_date,
       mapping.trade_date AS computed_trade_date
FROM sehknews n
LEFT JOIN (
    SELECT effective_date, trade_date
    FROM (
        SELECT nd.effective_date, td.trade_date,
               ROW_NUMBER() OVER (PARTITION BY nd.effective_date ORDER BY td.trade_date) AS rn
        FROM (
            SELECT DISTINCT
                CASE WHEN HOUR(`timestamp`) >= 16
                     THEN DATE_ADD(DATE(`timestamp`), INTERVAL 1 DAY)
                     ELSE DATE(`timestamp`)
                END AS effective_date
            FROM sehknews
        ) nd
        JOIN (
            SELECT DISTINCT {sis_dates}
        ) td
          ON td.trade_date >= nd.effective_date
         AND td.trade_date <= DATE_ADD(nd.effective_date, INTERVAL 10 DAY)
    ) ranked
    WHERE rn = 1
) mapping
  ON mapping.effective_date = CASE WHEN HOUR(n.`timestamp`) >= 16
                                   THEN DATE_ADD(DATE(n.`timestamp`), INTERVAL 1 DAY)
                                   ELSE DATE(n.`timestamp`)
                              END
ORDER BY n.securitycode, n.`timestamp`;
""".format(sis_dates=f"{sis_trade_date_expr()} AS trade_date FROM ms_t_stk_sis WHERE SITXDT IS NOT NULL"),
        output_dir / "sehknews.trade_date.tsv",
    )

    query_to_tsv(
        mysql,
        f"""
SELECT trade_date,
       HSHSI,
       HSFIN,
       HSUTL,
       HSPROP,
       HSCANI,
       COALESCE(
         (HSHSI - LAG(HSHSI) OVER (ORDER BY trade_date))
         / LAG(HSHSI) OVER (ORDER BY trade_date) * 100,
         0
       ) AS hsi_pct_change
FROM (
  SELECT {hsi_trade_date_expr()} AS trade_date, HSHSI, HSFIN, HSUTL, HSPROP, HSCANI
  FROM ms_t_stk_hsi
  WHERE CLOSING = 9
) h
ORDER BY trade_date;
""",
        output_dir / "ms_v_stk_hsi_daily.tsv",
    )


def read_tsv_lines(path: Path) -> Iterable[list[str]]:
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.reader(f, delimiter="\t")
        for row in reader:
            yield row


def clean_tsv_value(value: str) -> str:
    if value == "" or value.upper() == "NULL":
        return r"\N"
    return value.replace("\t", " ").replace("\r", " ").replace("\n", " ")


def export_industry(mysql: MySQL, output_dir: Path) -> Path:
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        cls_path = tmpdir / "industry_cls.tsv"
        cap_path = tmpdir / "cap_dates.tsv"
        mysql.run(
            """
SELECT STOCK_CODE, MODIFIED_DATE, INDUSTRY_NAME
FROM ds_t_int_hsicl_dtl
ORDER BY STOCK_CODE, MODIFIED_DATE;
""",
            output=cls_path,
        )
        mysql.run(
            f"""
SELECT DISTINCT STKCD, ref_date
FROM (
  SELECT STKCD, {cap_ref_date_expr()} AS ref_date
  FROM ms_v_stock_capital
  WHERE SIRXDT IS NOT NULL
) c
ORDER BY STKCD, ref_date;
""",
            output=cap_path,
        )

        cls: dict[str, list[tuple[str, str]]] = {}
        for row in read_tsv_lines(cls_path):
            if len(row) >= 3:
                code, date, name = row[0], row[1], row[2]
                if code and date and date.upper() != "NULL":
                    cls.setdefault(code, []).append((date, name))
        for rows in cls.values():
            rows.sort()

        out_path = output_dir / "ms_v_stock_capital.industry_name.tsv"
        with out_path.open("w", encoding="utf-8", newline="") as out:
            writer = csv.writer(out, delimiter="\t", lineterminator="\n")
            writer.writerow(["STKCD", "ref_date", "computed_industry_name"])
            for row in read_tsv_lines(cap_path):
                if len(row) < 2:
                    continue
                stkcd, ref_date = row[0], row[1]
                records = cls.get(stkcd, [])
                if not records:
                    continue
                dates = [r[0] for r in records]
                idx = bisect_right(dates, ref_date) - 1
                if idx >= 0:
                    writer.writerow([stkcd, ref_date, clean_tsv_value(records[idx][1])])
        print(f"wrote {out_path}")
        return out_path


class RollingAvg:
    __slots__ = ("w", "buf", "s", "c")

    def __init__(self, w: int):
        self.w = w
        self.buf: deque[Optional[float]] = deque()
        self.s = 0.0
        self.c = 0

    def add(self, value: Optional[float]) -> None:
        if len(self.buf) >= self.w:
            old = self.buf.popleft()
            if old is not None:
                self.s -= old
                self.c -= 1
        self.buf.append(value)
        if value is not None:
            self.s += value
            self.c += 1

    def avg(self) -> Optional[float]:
        return self.s / self.c if len(self.buf) >= self.w and self.c else None

    def reset(self) -> None:
        self.buf.clear()
        self.s = 0.0
        self.c = 0


def parse_float(value: str) -> Optional[float]:
    if not value or value.upper() == "NULL":
        return None
    return float(value)


def fmt_float(value: Optional[float]) -> str:
    return f"{value:.10f}" if value is not None else r"\N"


def export_sis_precompute(mysql: MySQL, output_dir: Path) -> Path:
    with tempfile.TemporaryDirectory() as tmp:
        input_path = Path(tmp) / "sis_source.tsv"
        mysql.run(
            f"""
SELECT SISTKC, trade_date, SICLSE, SIVOL
FROM (
  SELECT SISTKC, {sis_trade_date_expr()} AS trade_date, SICLSE, SIVOL
  FROM ms_t_stk_sis
  WHERE SITXDT IS NOT NULL
) s
ORDER BY SISTKC, trade_date;
""",
            output=input_path,
        )
        out_path = output_dir / "ms_t_stk_sis.precomputed_features.tsv"
        with out_path.open("w", encoding="utf-8", newline="") as out:
            writer = csv.writer(out, delimiter="\t", lineterminator="\n")
            writer.writerow(
                [
                    "SISTKC",
                    "trade_date",
                    "ma_3",
                    "ma_20",
                    "ma_50",
                    "ma_100",
                    "consecutive_above_ma3",
                    "consecutive_above_ma3_start",
                    "consecutive_above_ma20",
                    "consecutive_above_ma20_start",
                    "consecutive_above_ma50",
                    "consecutive_above_ma50_start",
                    "avg_vol_30d",
                ]
            )

            prev = None
            r3 = RollingAvg(3)
            r20 = RollingAvg(20)
            r50 = RollingAvg(50)
            r100 = RollingAvg(100)
            streak3 = streak20 = streak50 = 0
            start3 = start20 = start50 = None
            vol_buf: deque[Optional[float]] = deque()
            vol_sum = 0.0
            vol_count = 0

            for row in read_tsv_lines(input_path):
                if len(row) < 4:
                    continue
                code, date, close_s, vol_s = row[0], row[1], row[2], row[3]
                close = parse_float(close_s)
                vol = parse_float(vol_s)

                if code != prev:
                    r3.reset()
                    r20.reset()
                    r50.reset()
                    r100.reset()
                    streak3 = streak20 = streak50 = 0
                    start3 = start20 = start50 = None
                    vol_buf = deque()
                    vol_sum = 0.0
                    vol_count = 0
                    prev = code

                r3.add(close)
                r20.add(close)
                r50.add(close)
                r100.add(close)
                ma3 = round(r3.avg(), 4) if r3.avg() is not None else None
                ma20 = round(r20.avg(), 4) if r20.avg() is not None else None
                ma50 = round(r50.avg(), 4) if r50.avg() is not None else None
                ma100 = round(r100.avg(), 4) if r100.avg() is not None else None

                if ma3 is not None and close is not None and close > ma3:
                    if streak3 == 0:
                        start3 = date
                    streak3 += 1
                else:
                    streak3 = 0
                    start3 = None

                if ma20 is not None and close is not None and close > ma20:
                    if streak20 == 0:
                        start20 = date
                    streak20 += 1
                else:
                    streak20 = 0
                    start20 = None

                if ma50 is not None and close is not None and close > ma50:
                    if streak50 == 0:
                        start50 = date
                    streak50 += 1
                else:
                    streak50 = 0
                    start50 = None

                avg_vol = vol_sum / vol_count if vol_count >= 20 else None
                vol_buf.append(vol)
                if vol is not None:
                    vol_sum += vol
                    vol_count += 1
                if len(vol_buf) > 30:
                    old = vol_buf.popleft()
                    if old is not None:
                        vol_sum -= old
                        vol_count -= 1

                writer.writerow(
                    [
                        code,
                        date,
                        fmt_float(ma3),
                        fmt_float(ma20),
                        fmt_float(ma50),
                        fmt_float(ma100),
                        str(streak3),
                        start3 or r"\N",
                        str(streak20),
                        start20 or r"\N",
                        str(streak50),
                        start50 or r"\N",
                        fmt_float(avg_vol),
                    ]
                )
        print(f"wrote {out_path}")
        return out_path


def export_all(mysql: MySQL, output_dir: Path) -> None:
    ensure_dir(output_dir)
    export_sql_features(mysql, output_dir)
    export_industry(mysql, output_dir)
    export_sis_precompute(mysql, output_dir)


def create_temp_tables(mysql: MySQL, output_dir: Path, suffix: str) -> tuple[str, str]:
    pre_table = f"_tmp_repro_precompute_{suffix}"
    ind_table = f"_tmp_repro_industry_{suffix}"
    mysql.run(f"DROP TABLE IF EXISTS {pre_table};")
    mysql.run(f"DROP TABLE IF EXISTS {ind_table};")
    mysql.run(
        f"""
CREATE TABLE {pre_table} (
  SISTKC VARCHAR(10),
  trade_date DATE,
  ma_3 DOUBLE,
  ma_20 DOUBLE,
  ma_50 DOUBLE,
  ma_100 DOUBLE,
  consecutive_above_ma3 INT,
  consecutive_above_ma3_start DATE,
  consecutive_above_ma20 INT,
  consecutive_above_ma20_start DATE,
  consecutive_above_ma50 INT,
  consecutive_above_ma50_start DATE,
  avg_vol_30d DOUBLE
);
"""
    )
    mysql.run(
        f"""
CREATE TABLE {ind_table} (
  STKCD VARCHAR(10),
  ref_date DATE,
  industry_name VARCHAR(100)
);
"""
    )
    mysql.run(
        f"""
LOAD DATA LOCAL INFILE '{sql_literal_path(output_dir / "ms_t_stk_sis.precomputed_features.tsv")}'
INTO TABLE {pre_table}
FIELDS TERMINATED BY '\\t'
LINES TERMINATED BY '\\n'
IGNORE 1 LINES;
"""
    )
    mysql.run(
        f"""
LOAD DATA LOCAL INFILE '{sql_literal_path(output_dir / "ms_v_stock_capital.industry_name.tsv")}'
INTO TABLE {ind_table}
FIELDS TERMINATED BY '\\t'
LINES TERMINATED BY '\\n'
IGNORE 1 LINES;
"""
    )
    return pre_table, ind_table


def nullsafe_eq(actual: str, expected: str) -> str:
    return f"(({actual} = {expected}) OR ({actual} IS NULL AND {expected} IS NULL))"


def verify_all(mysql: MySQL, output_dir: Path, keep_temp: bool) -> None:
    export_all(mysql, output_dir)
    suffix = f"{os.getpid()}_{random.randint(1000, 9999)}"
    pre_table, ind_table = create_temp_tables(mysql, output_dir, suffix)
    summary_sql = f"""
SELECT 'ms_t_stk_hsi.trade_date' AS feature, COUNT(*) AS mismatch_count
FROM (
  SELECT trade_date AS actual_value, {hsi_trade_date_expr()} AS expected_value
  FROM ms_t_stk_hsi
) x
WHERE NOT {nullsafe_eq('actual_value', 'expected_value')}
UNION ALL
SELECT 'ms_t_stk_sis.trade_date', COUNT(*)
FROM (
  SELECT trade_date AS actual_value, {sis_trade_date_expr()} AS expected_value
  FROM ms_t_stk_sis
) x
WHERE NOT {nullsafe_eq('actual_value', 'expected_value')}
UNION ALL
SELECT 'ms_v_stock_capital.ref_date', COUNT(*)
FROM (
  SELECT ref_date AS actual_value, {cap_ref_date_expr()} AS expected_value
  FROM ms_v_stock_capital
) x
WHERE NOT {nullsafe_eq('actual_value', 'expected_value')}
UNION ALL
SELECT 'sehknews.trade_date', COUNT(*)
FROM sehknews n
LEFT JOIN (
    SELECT effective_date, trade_date
    FROM (
        SELECT nd.effective_date, td.trade_date,
               ROW_NUMBER() OVER (PARTITION BY nd.effective_date ORDER BY td.trade_date) AS rn
        FROM (
            SELECT DISTINCT
                CASE WHEN HOUR(`timestamp`) >= 16
                     THEN DATE_ADD(DATE(`timestamp`), INTERVAL 1 DAY)
                     ELSE DATE(`timestamp`)
                END AS effective_date
            FROM sehknews
        ) nd
        JOIN (
          SELECT DISTINCT {sis_trade_date_expr()} AS trade_date
          FROM ms_t_stk_sis
          WHERE SITXDT IS NOT NULL
        ) td
          ON td.trade_date >= nd.effective_date
         AND td.trade_date <= DATE_ADD(nd.effective_date, INTERVAL 10 DAY)
    ) ranked
    WHERE rn = 1
) mapping
  ON mapping.effective_date = CASE WHEN HOUR(n.`timestamp`) >= 16
                                   THEN DATE_ADD(DATE(n.`timestamp`), INTERVAL 1 DAY)
                                   ELSE DATE(n.`timestamp`)
                              END
WHERE NOT ((n.trade_date = mapping.trade_date) OR (n.trade_date IS NULL AND mapping.trade_date IS NULL))
UNION ALL
SELECT 'ms_v_stock_capital.industry_name', COUNT(*)
FROM ms_v_stock_capital t
LEFT JOIN {ind_table} p ON t.STKCD = p.STKCD AND t.ref_date = p.ref_date
WHERE NOT {nullsafe_eq('t.industry_name', 'p.industry_name')}
UNION ALL
SELECT 'ms_t_stk_sis.precomputed_features', COUNT(*)
FROM ms_t_stk_sis t
JOIN {pre_table} p ON t.SISTKC = p.SISTKC AND t.trade_date = p.trade_date
WHERE
  ((t.ma_3 IS NULL AND p.ma_3 IS NOT NULL) OR (t.ma_3 IS NOT NULL AND p.ma_3 IS NULL) OR (t.ma_3 IS NOT NULL AND ABS(CAST(t.ma_3 AS DOUBLE) - p.ma_3) > 0.00005))
  OR ((t.ma_20 IS NULL AND p.ma_20 IS NOT NULL) OR (t.ma_20 IS NOT NULL AND p.ma_20 IS NULL) OR (t.ma_20 IS NOT NULL AND ABS(CAST(t.ma_20 AS DOUBLE) - p.ma_20) > 0.00005))
  OR ((t.ma_50 IS NULL AND p.ma_50 IS NOT NULL) OR (t.ma_50 IS NOT NULL AND p.ma_50 IS NULL) OR (t.ma_50 IS NOT NULL AND ABS(CAST(t.ma_50 AS DOUBLE) - p.ma_50) > 0.00005))
  OR ((t.ma_100 IS NULL AND p.ma_100 IS NOT NULL) OR (t.ma_100 IS NOT NULL AND p.ma_100 IS NULL) OR (t.ma_100 IS NOT NULL AND ABS(CAST(t.ma_100 AS DOUBLE) - p.ma_100) > 0.00005))
  OR NOT {nullsafe_eq('t.consecutive_above_ma3', 'p.consecutive_above_ma3')}
  OR NOT {nullsafe_eq('t.consecutive_above_ma3_start', 'p.consecutive_above_ma3_start')}
  OR NOT {nullsafe_eq('t.consecutive_above_ma20', 'p.consecutive_above_ma20')}
  OR NOT {nullsafe_eq('t.consecutive_above_ma20_start', 'p.consecutive_above_ma20_start')}
  OR NOT {nullsafe_eq('t.consecutive_above_ma50', 'p.consecutive_above_ma50')}
  OR NOT {nullsafe_eq('t.consecutive_above_ma50_start', 'p.consecutive_above_ma50_start')}
  OR ((t.avg_vol_30d IS NULL AND p.avg_vol_30d IS NOT NULL) OR (t.avg_vol_30d IS NOT NULL AND p.avg_vol_30d IS NULL) OR (t.avg_vol_30d IS NOT NULL AND ABS(CAST(t.avg_vol_30d AS DOUBLE) - p.avg_vol_30d) > 0.000001))
UNION ALL
SELECT 'ms_v_stk_hsi_daily', COUNT(*)
FROM (
  SELECT trade_date,
         HSHSI,
         HSFIN,
         HSUTL,
         HSPROP,
         HSCANI,
         COALESCE((HSHSI - LAG(HSHSI) OVER (ORDER BY trade_date)) / LAG(HSHSI) OVER (ORDER BY trade_date) * 100, 0) AS hsi_pct_change
  FROM (
    SELECT {hsi_trade_date_expr()} AS trade_date, HSHSI, HSFIN, HSUTL, HSPROP, HSCANI
    FROM ms_t_stk_hsi
    WHERE CLOSING = 9
  ) h
) e
LEFT JOIN ms_v_stk_hsi_daily a ON a.trade_date = e.trade_date
WHERE a.trade_date IS NULL
   OR ABS(CAST(a.HSHSI AS DOUBLE) - e.HSHSI) > 0.00005
   OR ABS(CAST(a.hsi_pct_change AS DOUBLE) - e.hsi_pct_change) > 0.000001;
"""
    query_to_tsv(mysql, summary_sql, output_dir / "verification_summary.tsv", headers=True)
    if not keep_temp:
        mysql.run(f"DROP TABLE IF EXISTS {pre_table};")
        mysql.run(f"DROP TABLE IF EXISTS {ind_table};")


def apply_all(mysql: MySQL, output_dir: Path, keep_temp: bool) -> None:
    export_all(mysql, output_dir)
    suffix = f"{os.getpid()}_{random.randint(1000, 9999)}"
    pre_table, ind_table = create_temp_tables(mysql, output_dir, suffix)

    mysql.run(f"UPDATE ms_t_stk_hsi SET trade_date = {hsi_trade_date_expr()};")
    mysql.run(f"UPDATE ms_t_stk_sis SET trade_date = {sis_trade_date_expr()};")
    mysql.run(f"UPDATE ms_v_stock_capital SET ref_date = {cap_ref_date_expr()};")
    mysql.run(
        """
UPDATE sehknews n
JOIN (
    SELECT effective_date, trade_date
    FROM (
        SELECT nd.effective_date, td.trade_date,
               ROW_NUMBER() OVER (PARTITION BY nd.effective_date ORDER BY td.trade_date) AS rn
        FROM (
            SELECT DISTINCT
                CASE WHEN HOUR(`timestamp`) >= 16
                     THEN DATE_ADD(DATE(`timestamp`), INTERVAL 1 DAY)
                     ELSE DATE(`timestamp`)
                END AS effective_date
            FROM sehknews
        ) nd
        JOIN (
            SELECT DISTINCT {sis_trade_date_expr()} AS trade_date
            FROM ms_t_stk_sis
            WHERE SITXDT IS NOT NULL
        ) td
          ON td.trade_date >= nd.effective_date
         AND td.trade_date <= DATE_ADD(nd.effective_date, INTERVAL 10 DAY)
    ) ranked
    WHERE rn = 1
) mapping
  ON mapping.effective_date = CASE WHEN HOUR(n.`timestamp`) >= 16
                                   THEN DATE_ADD(DATE(n.`timestamp`), INTERVAL 1 DAY)
                                   ELSE DATE(n.`timestamp`)
                              END
SET n.trade_date = mapping.trade_date;
"""
    )
    mysql.run("UPDATE ms_v_stock_capital SET industry_name = NULL;")
    mysql.run(
        f"""
UPDATE ms_v_stock_capital t
JOIN {ind_table} p ON t.STKCD = p.STKCD AND t.ref_date = p.ref_date
SET t.industry_name = p.industry_name;
"""
    )
    mysql.run(
        f"""
UPDATE ms_t_stk_sis t
JOIN {pre_table} p ON t.SISTKC = p.SISTKC AND t.trade_date = p.trade_date
SET t.ma_3 = p.ma_3,
    t.ma_20 = p.ma_20,
    t.ma_50 = p.ma_50,
    t.ma_100 = p.ma_100,
    t.consecutive_above_ma3 = p.consecutive_above_ma3,
    t.consecutive_above_ma3_start = p.consecutive_above_ma3_start,
    t.consecutive_above_ma20 = p.consecutive_above_ma20,
    t.consecutive_above_ma20_start = p.consecutive_above_ma20_start,
    t.consecutive_above_ma50 = p.consecutive_above_ma50,
    t.consecutive_above_ma50_start = p.consecutive_above_ma50_start,
    t.avg_vol_30d = p.avg_vol_30d;
"""
    )
    mysql.run("DROP TABLE IF EXISTS ms_v_stk_hsi_daily;")
    mysql.run(
        """
CREATE TABLE ms_v_stk_hsi_daily AS
SELECT trade_date,
       HSHSI,
       HSFIN,
       HSUTL,
       HSPROP,
       HSCANI,
       (HSHSI - LAG(HSHSI) OVER (ORDER BY trade_date))
       / LAG(HSHSI) OVER (ORDER BY trade_date) * 100 AS hsi_pct_change
FROM ms_t_stk_hsi
WHERE CLOSING = 9
ORDER BY trade_date;
"""
    )
    mysql.run("UPDATE ms_v_stk_hsi_daily SET hsi_pct_change = 0 WHERE hsi_pct_change IS NULL;")
    if not keep_temp:
        mysql.run(f"DROP TABLE IF EXISTS {pre_table};")
        mysql.run(f"DROP TABLE IF EXISTS {ind_table};")
    print("applied reproduced features to database")


def run_one_click(mysql: MySQL, output_dir: Path, query_sql_path: Path, result_path: Path) -> None:
    if not query_sql_path.exists():
        raise SystemExit(f"query SQL file not found: {query_sql_path}")
    verify_all(mysql, output_dir, keep_temp=False)
    query_sql = query_sql_path.read_text(encoding="utf-8").strip()
    if not query_sql:
        raise SystemExit(f"query SQL file is empty: {query_sql_path}")
    query_to_csv(mysql, query_sql, result_path)
    print("")
    print("done")
    print(f"- query result: {result_path}")
    print(f"- verification summary: {output_dir / 'verification_summary.tsv'}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Reproduce HK_POC precomputed data transformations.")
    parser.add_argument("--mode", choices=["run", "export", "verify", "apply"], default="run")
    parser.add_argument("--output", default="output/feature_reproduction")
    parser.add_argument("--query-sql", default="query.sql")
    parser.add_argument("--result", default="result.csv")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--user")
    parser.add_argument("--password")
    parser.add_argument("--database")
    parser.add_argument("--mysql-bin", default=None)
    parser.add_argument("--keep-temp", action="store_true")
    parser.add_argument("--yes", action="store_true", help="required for --mode apply")
    args = parser.parse_args()

    if args.mode == "apply" and not args.yes:
        raise SystemExit("--mode apply modifies database tables; rerun with --yes to confirm")

    output_dir = Path(args.output)
    ensure_dir(output_dir)
    mysql = MySQL(args)

    if args.mode == "run":
        run_one_click(mysql, output_dir, Path(args.query_sql), Path(args.result))
    elif args.mode == "export":
        export_all(mysql, output_dir)
    elif args.mode == "verify":
        verify_all(mysql, output_dir, args.keep_temp)
    elif args.mode == "apply":
        apply_all(mysql, output_dir, args.keep_temp)
    else:
        raise AssertionError(args.mode)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
