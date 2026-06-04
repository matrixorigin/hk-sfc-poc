#!/usr/bin/env python3
import csv
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "backend" / "reproduction_assets" / "10_reproduce_features.py"


FAKE_MYSQL = r'''
#!/usr/bin/env python3
import sys

sql = sys.stdin.read()
headers = "--column-names" in sys.argv

def emit(rows, cols=None):
    if headers and cols:
        print("\t".join(cols))
    for row in rows:
        print("\t".join(str(v) for v in row))

if "FROM ds_t_int_hsicl_dtl" in sql:
    emit([["00001", "2025-01-31", "Finance"]])
elif "SELECT DISTINCT STKCD, ref_date" in sql:
    emit([["00001", "2025-02-28"]])
elif "SELECT SISTKC, trade_date, SICLSE, SIVOL" in sql:
    rows = []
    for i in range(31):
        rows.append(["00001", f"2025-01-{i + 1:02d}", f"{10 + i:.4f}", str(100 + i)])
    emit(rows)
elif "SELECT HSTXDT" in sql:
    emit([["02JAN2025:00:00:00", "2025-01-02"]], ["HSTXDT", "computed_trade_date"])
elif "SELECT SISTKC, SITXDT" in sql:
    emit([["00001", "02JAN2025:00:00:00", "2025-01-02"]], ["SISTKC", "SITXDT", "computed_trade_date"])
elif "SELECT STKCD, SIRXDT" in sql:
    emit([["00001", "28FEB25", "2025-02-28"]], ["STKCD", "SIRXDT", "computed_ref_date"])
elif "FROM sehknews n" in sql and "computed_trade_date" in sql:
    emit([["00001", "2025-01-02 17:00:00", "2025-01-03", "2025-01-03"]], ["securitycode", "timestamp", "effective_date", "computed_trade_date"])
elif "WHERE CLOSING = 9" in sql and "hsi_pct_change" in sql and "UNION ALL" not in sql:
    emit([["2025-01-02", "20000", "1", "2", "3", "4", "0"]], ["trade_date", "HSHSI", "HSFIN", "HSUTL", "HSPROP", "HSCANI", "hsi_pct_change"])
elif "UNION ALL" in sql and "mismatch_count" in sql:
    emit(
        [
            ["ms_t_stk_hsi.trade_date", "0"],
            ["ms_t_stk_sis.trade_date", "0"],
            ["ms_v_stock_capital.ref_date", "0"],
            ["sehknews.trade_date", "0"],
            ["ms_v_stock_capital.industry_name", "0"],
            ["ms_t_stk_sis.precomputed_features", "0"],
            ["ms_v_stk_hsi_daily", "0"],
        ],
        ["feature", "mismatch_count"],
    )
elif "SELECT 42 AS answer" in sql:
    emit([["42"]], ["answer"])
else:
    # DDL, LOAD DATA, UPDATE, DROP in verify/apply modes.
    pass
'''


class ReproduceFeaturesScriptTest(unittest.TestCase):
    def test_default_run_writes_final_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            fake = tmpdir / "fake_mysql.py"
            fake.write_text(textwrap.dedent(FAKE_MYSQL).lstrip(), encoding="utf-8")
            fake.chmod(0o755)
            query = tmpdir / "query.sql"
            query.write_text("SELECT 42 AS answer\n", encoding="utf-8")
            out = tmpdir / "features"
            result = tmpdir / "result.csv"
            env = os.environ.copy()
            env.update({
                "MO_USER": "u",
                "MO_PASSWORD": "p",
                "MO_DB": "db",
            })
            subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--output",
                    str(out),
                    "--query-sql",
                    str(query),
                    "--result",
                    str(result),
                    "--mysql-bin",
                    str(fake),
                ],
                env=env,
                check=True,
            )

            self.assertEqual(result.read_text(encoding="utf-8"), "answer\n42\n")
            self.assertTrue((out / "verification_summary.tsv").exists())

    def test_export_computes_shifted_avg_volume(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            fake = tmpdir / "fake_mysql.py"
            fake.write_text(textwrap.dedent(FAKE_MYSQL).lstrip(), encoding="utf-8")
            fake.chmod(0o755)
            out = tmpdir / "features"
            env = os.environ.copy()
            env.update({
                "MO_USER": "u",
                "MO_PASSWORD": "p",
                "MO_DB": "db",
            })
            subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "export",
                    "--output",
                    str(out),
                    "--mysql-bin",
                    str(fake),
                ],
                env=env,
                check=True,
            )

            precomputed = out / "ms_t_stk_sis.precomputed_features.tsv"
            self.assertTrue(precomputed.exists())
            with precomputed.open(encoding="utf-8", newline="") as f:
                rows = list(csv.DictReader(f, delimiter="\t"))

            self.assertEqual(rows[0]["avg_vol_30d"], r"\N")
            self.assertEqual(rows[19]["avg_vol_30d"], r"\N")
            self.assertEqual(rows[20]["avg_vol_30d"], "109.5000000000")
            self.assertEqual(rows[20]["ma_3"], "29.0000000000")
            self.assertEqual(rows[20]["consecutive_above_ma3"], "19")

    def test_verify_writes_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            fake = tmpdir / "fake_mysql.py"
            fake.write_text(textwrap.dedent(FAKE_MYSQL).lstrip(), encoding="utf-8")
            fake.chmod(0o755)
            out = tmpdir / "features"
            env = os.environ.copy()
            env.update({
                "MO_USER": "u",
                "MO_PASSWORD": "p",
                "MO_DB": "db",
            })
            subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--mode",
                    "verify",
                    "--output",
                    str(out),
                    "--mysql-bin",
                    str(fake),
                ],
                env=env,
                check=True,
            )

            summary = out / "verification_summary.tsv"
            self.assertTrue(summary.exists())
            text = summary.read_text(encoding="utf-8")
            self.assertIn("ms_t_stk_sis.precomputed_features\t0", text)


if __name__ == "__main__":
    unittest.main()
