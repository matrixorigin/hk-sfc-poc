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

    # 只爬不入库（保存本地 CSV，可后续用 --from-cache 入库）
    python 03_import_ccass.py --dates 2026/03/18 --dry-run

    # 从本地缓存入库（跳过爬取）
    python 03_import_ccass.py --dates 2026/03/18 2026/03/17 --from-cache

    # 指定缓存目录
    python 03_import_ccass.py --dates 2026/03/18 --cache-dir /tmp/ccass_cache

依赖:
    pip install requests beautifulsoup4
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
DEFAULT_CACHE_DIR = "data/ccass_cache"


def parse_args():
    p = argparse.ArgumentParser(description="CCASS holdings crawler → MatrixOne")
    p.add_argument("--dates", nargs="+", required=True, help="日期列表, 格式 yyyy/mm/dd")
    p.add_argument("--top", type=int, default=200, help="爬取前 N 只股票 (默认 200)")
    p.add_argument("--all", action="store_true", help="爬全量股票 (覆盖 --top)")
    p.add_argument("--mo-host", default=os.getenv("MO_HOST", "127.0.0.1"))
    p.add_argument("--mo-port", default=os.getenv("MO_PORT", "16002"))
    p.add_argument("--mo-user", default=os.getenv("MO_USER", "dump"))
    p.add_argument("--mo-pass", default=os.getenv("MO_PASS", "111"))
    p.add_argument("--mo-db", default="hk_sfc")
    p.add_argument("--dry-run", action="store_true", help="只爬不入库，保存本地 CSV")
    p.add_argument("--from-cache", action="store_true", help="跳过爬取，从本地缓存入库")
    p.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR, help="缓存目录 (默认 data/ccass_cache)")
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


# ── 缓存 ──

def cache_path(cache_dir: str, date: str) -> str:
    """返回某天数据的缓存文件路径"""
    db_date = date.replace("/", "-")
    return os.path.join(cache_dir, f"ccass_{db_date}.csv")


def save_to_cache(rows: list, cache_dir: str, date: str):
    """将一天的数据保存到本地 CSV 缓存"""
    os.makedirs(cache_dir, exist_ok=True)
    path = cache_path(cache_dir, date)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["holding_date", "stock_code", "stock_name", "participant_id", "shareholding"])
        writer.writerows(rows)
    print(f"  -> 缓存已保存: {path} ({len(rows)} 行)")


def load_from_cache(cache_dir: str, date: str) -> list:
    """从本地 CSV 缓存加载一天的数据"""
    path = cache_path(cache_dir, date)
    if not os.path.exists(path):
        print(f"  缓存不存在: {path}")
        return []
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.reader(f)
        next(reader)  # skip header
        for r in reader:
            rows.append(tuple(r))
    print(f"  -> 从缓存加载: {path} ({len(rows)} 行)")
    return rows


# ── 爬取 ──

def crawl_date(date: str, stocks: list, cache_dir: str = None) -> list:
    """爬取一天的所有股票持仓，返回 rows 列表。每只股票爬完立即追加到缓存文件。"""
    session, vs, vs_gn = get_session()
    rows = []
    db_date = date.replace("/", "-")

    # 准备追加模式的缓存文件
    cache_file = None
    cache_writer = None
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        path = cache_path(cache_dir, date)
        cache_file = open(path, "w", newline="", encoding="utf-8")
        cache_writer = csv.writer(cache_file)
        cache_writer.writerow(["holding_date", "stock_code", "stock_name", "participant_id", "shareholding"])

    try:
        for i, (code, name) in enumerate(stocks, 1):
            print(f"  [{i}/{len(stocks)}] {code} {name}", end=" ... ", flush=True)
            try:
                brokers = fetch_broker_holdings(session, vs, vs_gn, code, date)
                print(f"{len(brokers)} brokers")
                for pid, sh in brokers.items():
                    row = (db_date, code, name, pid, sh)
                    rows.append(row)
                    if cache_writer:
                        cache_writer.writerow(row)
                # 每只股票爬完就 flush 缓存
                if cache_file:
                    cache_file.flush()
            except Exception as e:
                print(f"ERROR: {e}")
            time.sleep(0.2)
    finally:
        if cache_file:
            cache_file.close()
            print(f"  -> 缓存已保存: {cache_path(cache_dir, date)} ({len(rows)} 行)")

    return rows


# ── MO 入库 ──

def mysql_args_list(args):
    """构造 mysql 命令参数列表（避免 shell 转义问题）"""
    return [
        "mysql", "-h", args.mo_host, "-P", str(args.mo_port),
        "-u", args.mo_user, f"-p{args.mo_pass}",
        "--local-infile=1", args.mo_db,
    ]


def load_rows_to_mo(rows, args):
    """将 rows 通过临时 CSV + LOAD DATA 写入 MO"""
    if not rows:
        print("  没有数据需要导入")
        return

    tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False,
                                      newline="", encoding="utf-8")
    try:
        writer = csv.writer(tmp)
        writer.writerow(["holding_date", "stock_code", "stock_name", "participant_id", "shareholding"])
        writer.writerows(rows)
        tmp.close()

        load_sql = (
            f"LOAD DATA LOCAL INFILE '{tmp.name}' INTO TABLE ccass_holdings "
            f"FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '\"' "
            f"LINES TERMINATED BY '\\n' IGNORE 1 LINES;"
        )

        print(f"  导入 {len(rows)} 行...", flush=True)
        subprocess.run(mysql_args_list(args) + ["-e", load_sql],
                       check=True, capture_output=True)
        print(f"  -> 入库完成")
    finally:
        os.unlink(tmp.name)


def main():
    args = parse_args()
    top_n = None if args.all else args.top

    print("=" * 60)
    print("CCASS Holdings Crawler → MatrixOne")
    print(f"日期: {args.dates}")
    print(f"股票数: {'全部' if args.all else f'前 {top_n}'}")
    print(f"缓存目录: {args.cache_dir}")
    if args.from_cache:
        print("模式: 从缓存入库（跳过爬取）")
    elif args.dry_run:
        print("模式: 只爬不入库")
    else:
        print(f"MO: {args.mo_host}:{args.mo_port}/{args.mo_db}")
    print("=" * 60)

    # 确保表存在
    if not args.dry_run:
        create_sql = (
            "CREATE TABLE IF NOT EXISTS ccass_holdings ("
            "holding_date DATE NOT NULL, "
            "stock_code VARCHAR(10) NOT NULL, "
            "stock_name VARCHAR(200) NULL, "
            "participant_id VARCHAR(20) NOT NULL, "
            "shareholding BIGINT NOT NULL);"
        )
        subprocess.run(mysql_args_list(args) + ["-e", create_sql], capture_output=True)

    # 清理目标日期的旧数据
    if not args.dry_run:
        db_dates = ",".join(f"'{d.replace('/', '-')}'" for d in args.dates)
        subprocess.run(
            mysql_args_list(args) + ["-e", f"DELETE FROM ccass_holdings WHERE holding_date IN ({db_dates});"],
            capture_output=True
        )
        print(f"已清理旧数据: {args.dates}")

    all_rows = []
    for date in args.dates:
        print(f"\n[{date}]")

        if args.from_cache:
            # 从缓存加载
            rows = load_from_cache(args.cache_dir, date)
        else:
            # 爬取（同时写缓存）
            stocks = fetch_stock_list(date, top_n=top_n)
            print(f"  股票列表: {len(stocks)} 只")
            rows = crawl_date(date, stocks, cache_dir=args.cache_dir)

        all_rows.extend(rows)
        print(f"  本日合计: {len(rows)} 条持仓记录")

        # 每天爬完就入库（不等全部日期完成）
        if not args.dry_run and rows:
            load_rows_to_mo(rows, args)

    print(f"\n总计 {len(all_rows)} 条记录")
    print("完成!")


if __name__ == "__main__":
    main()
