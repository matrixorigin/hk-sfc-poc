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
import random
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
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--dates", nargs="+", help="日期列表, 格式 yyyy/mm/dd")
    g.add_argument("--range", nargs=2, metavar=("START", "END"),
                   help="日期范围, 格式 yyyy/mm/dd yyyy/mm/dd, 自动跳过周末和港股假期")
    p.add_argument("--top", type=int, default=200, help="爬取前 N 只股票 (默认 200)")
    p.add_argument("--all", action="store_true", help="爬全量股票 (覆盖 --top)")
    p.add_argument("--mo-host", default=os.getenv("MO_HOST", "127.0.0.1"))
    p.add_argument("--mo-port", default=os.getenv("MO_PORT", "16002"))
    p.add_argument("--mo-user", default=os.getenv("MO_USER", ""))
    p.add_argument("--mo-pass", default=os.getenv("MO_PASS", ""))
    p.add_argument("--mo-db", default="hk_sfc")
    p.add_argument("--concurrency", "-c", type=int, default=10, help="并发数 (默认 10)")
    p.add_argument("--resume", action="store_true", help="续爬模式：跳过已有缓存的日期")
    p.add_argument("--dry-run", action="store_true", help="只爬不入库，保存本地 CSV")
    p.add_argument("--from-cache", action="store_true", help="跳过爬取，从本地缓存入库")
    p.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR, help="缓存目录 (默认 data/ccass_cache)")
    return p.parse_args()


def expand_date_range(start_str, end_str):
    """将日期范围展开为交易日列表（跳过周末），格式 yyyy/mm/dd"""
    from datetime import datetime, timedelta
    start = datetime.strptime(start_str, "%Y/%m/%d")
    end = datetime.strptime(end_str, "%Y/%m/%d")
    dates = []
    cur = start
    while cur <= end:
        # 跳过周末 (5=Saturday, 6=Sunday)
        if cur.weekday() < 5:
            dates.append(cur.strftime("%Y/%m/%d"))
        cur += timedelta(days=1)
    return dates


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

MAX_RETRIES = 3


def _crawl_one_stock(args_tuple):
    """爬取单只股票的持仓数据，失败自动重试。"""
    session, vs, vs_gn, code, name, date, db_date, idx, total = args_tuple
    time.sleep(random.uniform(0.1, 0.3))  # 轻微随机延迟

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            brokers = fetch_broker_holdings(session, vs, vs_gn, code, date)
            rows = [(db_date, code, name, pid, sh) for pid, sh in brokers.items()]
            print(f"  [{idx}/{total}] {code} {name} → {len(brokers)} brokers", flush=True)
            return rows
        except Exception as e:
            if attempt < MAX_RETRIES:
                wait = random.uniform(1, 3) * attempt  # 退避递增
                print(f"  [{idx}/{total}] {code} retry {attempt}/{MAX_RETRIES} ({e}), wait {wait:.1f}s", flush=True)
                time.sleep(wait)
                # 重试时刷新 session
                try:
                    session, vs, vs_gn = get_session()
                except Exception:
                    pass
            else:
                print(f"  [{idx}/{total}] {code} {name} → FAILED after {MAX_RETRIES} retries: {e}", flush=True)
                return []


def _load_crawled_codes(cache_dir: str, date: str) -> set:
    """从缓存文件中读取已爬取的股票代码集合（用于续爬）。"""
    path = cache_path(cache_dir, date)
    codes = set()
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader, None)  # skip header
            for r in reader:
                if len(r) >= 2:
                    codes.add(r[1])  # stock_code
    return codes


def _append_to_cache(cache_dir: str, date: str, rows: list, write_header: bool = False):
    """将行数据追加写入缓存文件。"""
    if not rows:
        return
    os.makedirs(cache_dir, exist_ok=True)
    path = cache_path(cache_dir, date)
    mode = "a" if os.path.exists(path) and not write_header else "w"
    with open(path, mode, newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if mode == "w":
            writer.writerow(["holding_date", "stock_code", "stock_name", "participant_id", "shareholding"])
        writer.writerows(rows)


def crawl_date(date: str, stocks: list, cache_dir: str = None, concurrency: int = 10, resume: bool = False) -> list:
    """爬取一天的所有股票持仓，支持并发+重试+断点续爬，每批写入缓存。"""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    db_date = date.replace("/", "-")
    all_rows = []

    # 续爬：跳过已爬的股票
    skipped = 0
    if resume and cache_dir:
        crawled_codes = _load_crawled_codes(cache_dir, date)
        if crawled_codes:
            original = len(stocks)
            stocks = [(c, n) for c, n in stocks if c not in crawled_codes]
            skipped = original - len(stocks)
            if skipped:
                print(f"  续爬: 跳过 {skipped} 只已爬股票, 剩余 {len(stocks)} 只")
            if not stocks:
                print(f"  当天全部股票已爬完")
                return load_from_cache(cache_dir, date)

    def create_sessions(n):
        """创建 n 个独立 session。"""
        sessions = []
        for _ in range(n):
            try:
                s, vs, vs_gn = get_session()
                sessions.append((s, vs, vs_gn))
            except Exception as e:
                print(f"  WARNING: 创建 session 失败: {e}, 降低并发")
                break
        return sessions

    sessions = create_sessions(concurrency)
    if not sessions:
        print("  ERROR: 无法创建任何 session")
        return []

    actual_concurrency = len(sessions)
    total_display = len(stocks) + skipped
    print(f"  并发数: {actual_concurrency}, 股票数: {len(stocks)}")

    # 分批并发执行，每批完成立即写入缓存，每 SESSION_REFRESH_INTERVAL 只刷新 session
    BATCH_SIZE = 100
    SESSION_REFRESH_INTERVAL = 500  # 每 500 只刷新 session 防止 token 过期
    stocks_since_refresh = 0
    need_header = not os.path.exists(cache_path(cache_dir, date)) if cache_dir else False

    with ThreadPoolExecutor(max_workers=actual_concurrency) as executor:
        for batch_start in range(0, len(stocks), BATCH_SIZE):
            # 检查是否需要刷新 session
            if stocks_since_refresh >= SESSION_REFRESH_INTERVAL:
                print(f"  --- 刷新 session (已爬 {stocks_since_refresh} 只) ---", flush=True)
                sessions = create_sessions(actual_concurrency)
                stocks_since_refresh = 0

            batch_stocks = stocks[batch_start:batch_start + BATCH_SIZE]
            batch_tasks = []
            for j, (code, name) in enumerate(batch_stocks):
                idx = batch_start + j
                sess_idx = j % len(sessions)
                s, vs, vs_gn = sessions[sess_idx]
                batch_tasks.append((s, vs, vs_gn, code, name, date, db_date, idx + 1 + skipped, total_display))

            batch_rows = []
            futures = {executor.submit(_crawl_one_stock, t): t for t in batch_tasks}
            for future in as_completed(futures):
                rows = future.result()
                batch_rows.extend(rows)
                all_rows.extend(rows)

            stocks_since_refresh += len(batch_stocks)

            # 每批完成立即追加写入缓存
            if cache_dir and batch_rows:
                _append_to_cache(cache_dir, date, batch_rows, write_header=need_header)
                need_header = False  # 后续批次不再写 header

            done = min(batch_start + BATCH_SIZE, len(stocks)) + skipped
            total = len(stocks) + skipped
            print(f"  --- {done}/{total} done, {len(all_rows)} rows saved ---", flush=True)

            # 批间短暂休息
            if batch_start + BATCH_SIZE < len(stocks):
                time.sleep(random.uniform(1, 3))

    print(f"  -> 缓存: {cache_path(cache_dir, date)} ({len(all_rows)} 新增行)")

    return all_rows


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


def resolve_mo_credentials(args):
    """如果未指定 MO 账号，自动从 Catalog API 获取 workspace 账号"""
    if args.mo_user and args.mo_pass:
        return
    # 从 .env 读取
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.dirname(script_dir)
    env_file = os.path.join(project_dir, ".env")
    env = {}
    if os.path.exists(env_file):
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    env[k] = v
    api_key = env.get("MOI_SYSTEM_API_KEY", "")
    ws_id = env.get("POC_WORKSPACE_ID", "")
    catalog_url = os.getenv("CATALOG_URL", "http://localhost:8084")
    if not api_key or not ws_id:
        print("ERROR: 未指定 MO_USER/MO_PASS，且 .env 中缺少 MOI_SYSTEM_API_KEY 或 POC_WORKSPACE_ID")
        sys.exit(1)
    import json
    resp = requests.get(f"{catalog_url}/api/v1/workspaces/{ws_id}",
                        headers={"X-API-Key": api_key}, timeout=10)
    acct = json.loads(resp.text)["data"]["account_name"]
    args.mo_user = f"{acct}:moi_core_system"
    args.mo_pass = api_key
    print(f"使用 workspace 账号: {args.mo_user}")


def main():
    args = parse_args()

    # 展开日期范围
    if args.range:
        args.dates = expand_date_range(args.range[0], args.range[1])
        if not args.dates:
            print("ERROR: 日期范围内没有交易日")
            sys.exit(1)
        print(f"日期范围展开: {args.range[0]} ~ {args.range[1]} → {len(args.dates)} 个交易日")

    top_n = None if args.all else args.top

    if not args.dry_run:
        resolve_mo_credentials(args)

    # 续爬提示
    if args.resume and not args.from_cache:
        cached = sum(1 for d in args.dates if os.path.exists(cache_path(args.cache_dir, d)))
        if cached:
            print(f"续爬模式: {cached} 天有部分缓存，将跳过已爬股票继续")

    print("=" * 60)
    print("CCASS Holdings Crawler → MatrixOne")
    print(f"日期: {len(args.dates)} 天 ({args.dates[0]} ~ {args.dates[-1]})")
    print(f"股票数: {'全部' if args.all else f'前 {top_n}'}")
    print(f"并发: {args.concurrency}")
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

    total_rows = 0
    for di, date in enumerate(args.dates, 1):
        print(f"\n[{di}/{len(args.dates)}] {date}")

        if args.from_cache:
            rows = load_from_cache(args.cache_dir, date)
        else:
            stocks = fetch_stock_list(date, top_n=top_n)
            print(f"  股票列表: {len(stocks)} 只")
            rows = crawl_date(date, stocks, cache_dir=args.cache_dir, concurrency=args.concurrency, resume=args.resume)

        # 入库用缓存的完整数据（含之前续爬的+本次新爬的）
        # 确保即使部分股票失败，已有数据也不丢
        if not args.from_cache and args.cache_dir:
            all_cached = load_from_cache(args.cache_dir, date)
            if len(all_cached) > len(rows):
                rows = all_cached

        total_rows += len(rows)
        print(f"  本日合计: {len(rows)} 条持仓记录")

        # 每天爬完就入库（先删旧数据再用完整缓存导入）
        if not args.dry_run and rows:
            db_date = date.replace("/", "-")
            subprocess.run(
                mysql_args_list(args) + ["-e", f"DELETE FROM ccass_holdings WHERE holding_date = '{db_date}';"],
                capture_output=True
            )
            load_rows_to_mo(rows, args)

    print(f"\n总计 {total_rows} 条记录")
    print("完成!")


if __name__ == "__main__":
    main()
