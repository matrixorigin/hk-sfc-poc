"""
CCASS 经纪商持仓爬取 → MatrixOne 入库
======================================
从 HKEX CCASS 公开页面爬取经纪商持仓数据，写入 MO 的 ccass_holdings 表。
Explore 引擎可直接 SQL 查询计算跨券商持仓变动。

用法:
    # 爬取指定日期（可多个），默认前 200 只股票
    python 03_import_ccass.py --dates 2026/03/18 2026/03/17

    # 全量股票
    python 03_import_ccass.py --dates 2026/03/18 2026/03/17 --all

    # 指定前 N 只
    python 03_import_ccass.py --dates 2026/03/18 2026/03/17 --top 500

依赖:
    pip install requests beautifulsoup4 pymysql
"""

import argparse
import csv
import os
import subprocess
import sys
import tempfile
import time

import requests
from bs4 import BeautifulSoup

# ── 常量 ──
SEARCH_URL = "https://www3.hkexnews.hk/sdw/search/searchsdw.aspx"
STOCKLIST_URL = "https://www3.hkexnews.hk/sdw/search/stocklist.aspx"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": SEARCH_URL,
}


def parse_args():
    p = argparse.ArgumentParser(description="CCASS holdings crawler → MatrixOne")
    p.add_argument("--dates", nargs="+", required=True, help="日期列表, 格式 yyyy/mm/dd")
    p.add_argument("--top", type=int, default=200, help="爬取前 N 只股票 (默认 200)")
    p.add_argument("--all", action="store_true", help="爬全量股票 (覆盖 --top)")
    p.add_argument("--mo-host", default=os.getenv("MO_HOST", "127.0.0.1"))
    p.add_argument("--mo-port", default=os.getenv("MO_PORT", "16001"))
    p.add_argument("--mo-user", default=os.getenv("MO_USER", "dump"))
    p.add_argument("--mo-pass", default=os.getenv("MO_PASS", "111"))
    p.add_argument("--mo-db", default="hk_sfc")
    p.add_argument("--dry-run", action="store_true", help="只爬不入库，输出 CSV")
    return p.parse_args()


def get_session():
    session = requests.Session()
    resp = session.get(SEARCH_URL, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    def _val(id_):
        tag = soup.find("input", {"id": id_})
        return tag["value"] if tag else ""

    vs = _val("__VIEWSTATE")
    vs_gn = _val("__VIEWSTATEGENERATOR")
    return session, vs, vs_gn


def fetch_stock_list(date: str, top_n=None):
    date_compact = date.replace("/", "")
    url = f"{STOCKLIST_URL}?sortby=stockcode&shareholdingdate={date_compact}"
    resp = requests.get(url, headers={**HEADERS, "Referer": SEARCH_URL}, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    stocks = [(item["c"], item["n"]) for item in data if "c" in item and "n" in item]
    if top_n and top_n < len(stocks):
        stocks = stocks[:top_n]
    return stocks


def fetch_broker_holdings(session, vs, vs_gn, stock_code: str, date: str):
    payload = {
        "__EVENTTARGET": "btnSearch",
        "__EVENTARGUMENT": "",
        "__VIEWSTATE": vs,
        "__VIEWSTATEGENERATOR": vs_gn,
        "txtShareholdingDate": date,
        "txtStockCode": stock_code,
        "txtStockName": "",
        "txtParticipantID": "",
        "txtParticipantName": "",
        "sortBy": "shareholding",
        "sortDirection": "desc",
    }
    resp = session.post(SEARCH_URL, headers=HEADERS, data=payload, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    alert = soup.find("input", {"id": "alertMsg"})
    if alert and alert.get("value", "").strip():
        return {}

    table = soup.find("table", {"class": "table"})
    if not table:
        return {}

    brokers = {}
    for row in table.find_all("tr")[1:]:
        cols = row.find_all("td")
        if len(cols) < 4:
            continue

        def cell_val(td):
            body = td.find("div", class_="mobile-list-body")
            return body.get_text(strip=True) if body else td.get_text(strip=True)

        pid = cell_val(cols[0])
        shareholding = cell_val(cols[3]).replace(",", "")

        if not pid.upper().startswith("B"):
            continue
        try:
            brokers[pid] = int(shareholding)
        except ValueError:
            continue

    return brokers


def crawl_date(date: str, stocks: list) -> list:
    """爬取一天的所有股票持仓，返回 [(date, stock_code, stock_name, pid, shareholding), ...]"""
    session, vs, vs_gn = get_session()
    rows = []
    # 将 yyyy/mm/dd 转换为 yyyy-mm-dd 用于数据库
    db_date = date.replace("/", "-")

    for i, (code, name) in enumerate(stocks, 1):
        print(f"  [{i}/{len(stocks)}] {code} {name}", end=" ... ", flush=True)
        try:
            brokers = fetch_broker_holdings(session, vs, vs_gn, code, date)
            print(f"{len(brokers)} brokers")
            for pid, sh in brokers.items():
                rows.append((db_date, code, name, pid, sh))
        except Exception as e:
            print(f"ERROR: {e}")
        time.sleep(0.2)

    return rows


def load_to_mo(rows, args):
    """将数据通过临时 CSV + LOAD DATA LOCAL INFILE 写入 MO"""
    if not rows:
        print("  没有数据需要导入")
        return

    # 先删除这些日期的旧数据
    dates = sorted(set(r[0] for r in rows))
    date_list = ",".join(f"'{d}'" for d in dates)
    delete_sql = f"DELETE FROM ccass_holdings WHERE holding_date IN ({date_list});"

    mysql_base = (
        f"mysql -h {args.mo_host} -P {args.mo_port} "
        f"-u {args.mo_user} -p{args.mo_pass} --local-infile=1 {args.mo_db}"
    )

    print(f"  清理旧数据: {dates}")
    subprocess.run(f'{mysql_base} -e "{delete_sql}"', shell=True, check=True,
                   capture_output=True)

    # 写临时 CSV
    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False,
                                      newline="", encoding="utf-8")
    try:
        writer = csv.writer(tmp)
        writer.writerow(["holding_date", "stock_code", "stock_name", "participant_id", "shareholding"])
        writer.writerows(rows)
        tmp.close()

        load_sql = (
            f"LOAD DATA LOCAL INFILE '{tmp.name}' INTO TABLE ccass_holdings "
            f"FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '\\\"' "
            f"LINES TERMINATED BY '\\n' IGNORE 1 LINES;"
        )

        print(f"  导入 {len(rows)} 行...")
        subprocess.run(f"{mysql_base} -e \"{load_sql}\"", shell=True, check=True,
                       capture_output=True)

        # 验证
        result = subprocess.run(
            f'{mysql_base} -N -e "SELECT COUNT(*) FROM ccass_holdings WHERE holding_date IN ({date_list});"',
            shell=True, capture_output=True, text=True
        )
        count = result.stdout.strip()
        print(f"  -> ccass_holdings 新增 {count} 行 (日期: {dates})")
    finally:
        os.unlink(tmp.name)


def main():
    args = parse_args()
    top_n = None if args.all else args.top

    print("=" * 60)
    print("CCASS Holdings Crawler → MatrixOne")
    print(f"日期: {args.dates}")
    print(f"股票数: {'全部' if args.all else f'前 {top_n}'}")
    print(f"MO: {args.mo_host}:{args.mo_port}/{args.mo_db}")
    print("=" * 60)

    # 确保表存在
    if not args.dry_run:
        mysql_base = (
            f"mysql -h {args.mo_host} -P {args.mo_port} "
            f"-u {args.mo_user} -p{args.mo_pass} {args.mo_db}"
        )
        create_sql = (
            "CREATE TABLE IF NOT EXISTS ccass_holdings ("
            "holding_date DATE NOT NULL, "
            "stock_code VARCHAR(10) NOT NULL, "
            "stock_name VARCHAR(200) NULL, "
            "participant_id VARCHAR(20) NOT NULL, "
            "shareholding BIGINT NOT NULL);"
        )
        subprocess.run(f'{mysql_base} -e "{create_sql}"', shell=True,
                       capture_output=True)

    all_rows = []
    for date in args.dates:
        print(f"\n[爬取] {date}")
        stocks = fetch_stock_list(date, top_n=top_n)
        print(f"  股票列表: {len(stocks)} 只")
        rows = crawl_date(date, stocks)
        all_rows.extend(rows)
        print(f"  本日合计: {len(rows)} 条持仓记录")

    print(f"\n总计爬取 {len(all_rows)} 条记录")

    if args.dry_run:
        out_csv = "ccass_holdings.csv"
        with open(out_csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["holding_date", "stock_code", "stock_name", "participant_id", "shareholding"])
            writer.writerows(all_rows)
        print(f"-> 保存至 {out_csv}")
    else:
        load_to_mo(all_rows, args)

    print("\n完成!")


if __name__ == "__main__":
    main()
