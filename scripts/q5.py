"""
CCASS Inter-Broker Movement Analysis
=====================================
对比两个交易日，找出任意经纪商（Broker）持股变化超过 ±30% 的股票。

逻辑：
  1. 从 ccass_stock_list.htm 获取全量股票列表
  2. 对每只股票，分别查询两个日期的持股数据
  3. 筛选 Participant ID 以 "B" 开头的行（经纪商）
  4. 对比同一经纪商在两日的持股，变化率超过阈值则记录该股票

使用方法：
    python ccass_movement.py

依赖：
    pip install requests beautifulsoup4 pandas openpyxl
"""

import re
import time
from datetime import datetime

import requests
from bs4 import BeautifulSoup
import pandas as pd

# ─────────────────────────────────────────
# 配置
# ─────────────────────────────────────────
DATE_NEW   = "2026/03/08"   # 较新日期（格式 yyyy/mm/dd）
DATE_OLD   = "2026/03/09"   # 较旧日期（格式 yyyy/mm/dd）
THRESHOLD  = 0.30           # 变化率阈值，0.30 = 30%
TOP_N      = 10             # 测试用：只取前 N 只股票，None = 全部

SEARCH_URL   = "https://www3.hkexnews.hk/sdw/search/searchsdw.aspx"
STOCKLIST_URL = "https://www3.hkexnews.hk/sdw/search/stocklist.aspx"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": SEARCH_URL,
}


# ─────────────────────────────────────────
# Step 1: 获取 Session / ViewState
# ─────────────────────────────────────────
def get_session():
    session = requests.Session()
    resp = session.get(SEARCH_URL, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    def _val(id_):
        tag = soup.find("input", {"id": id_})
        return tag["value"] if tag else ""

    vs    = _val("__VIEWSTATE")
    vs_gn = _val("__VIEWSTATEGENERATOR")
    print(f"  ✓ Session OK  ViewState={vs[:40]}...")
    return session, vs, vs_gn


# ─────────────────────────────────────────
# Step 2: 从 ccass_stock_list.htm 获取全量股票列表
# ─────────────────────────────────────────
def fetch_stock_list(date: str, top_n=None) -> list:
    """
    请求 stocklist.aspx?sortby=stockcode&shareholdingdate=YYYYMMDD
    返回 JSON 格式：[{"c": "00001", "n": "CK HUTCHISON..."}, ...]
    """
    date_compact = date.replace("/", "")   # 20260309
    url = f"{STOCKLIST_URL}?sortby=stockcode&shareholdingdate={date_compact}"

    print(f"\n[Step 2] 获取股票列表: {url}")

    req_headers = {**HEADERS, "Referer": SEARCH_URL}
    resp = requests.get(url, headers=req_headers, timeout=30)
    resp.raise_for_status()

    # 返回 JSON：[{"c": "00001", "n": "NAME"}, ...]
    data = resp.json()
    stocks = [(item["c"], item["n"]) for item in data if "c" in item and "n" in item]

    print(f"  ✓ 共获取 {len(stocks)} 只股票")

    if top_n:
        stocks = stocks[:top_n]
        print(f"  ► 测试模式：仅取前 {top_n} 只")

    return stocks


# ─────────────────────────────────────────
# Step 3: 查询单只股票在某日各 Broker 持股
# ─────────────────────────────────────────
def fetch_broker_holdings(session, vs, vs_gn, stock_code: str, date: str) -> dict:
    """
    POST 查询，返回 {participant_id: shareholding} 字典
    只保留 Participant ID 以 "B" 开头的行（经纪商）
    """
    payload = {
        "__EVENTTARGET":        "btnSearch",
        "__EVENTARGUMENT":      "",
        "__VIEWSTATE":          vs,
        "__VIEWSTATEGENERATOR": vs_gn,
        "txtShareholdingDate":  date,
        "txtStockCode":         stock_code,
        "txtStockName":         "",
        "txtParticipantID":     "",
        "txtParticipantName":   "",
        "sortBy":               "shareholding",
        "sortDirection":        "desc",
    }

    resp = session.post(SEARCH_URL, headers=HEADERS, data=payload, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    # 检查错误
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

        # 提取 Participant ID（在 mobile-list-body 或直接 td 文本）
        def cell_val(td):
            body = td.find("div", class_="mobile-list-body")
            return body.get_text(strip=True) if body else td.get_text(strip=True)

        pid          = cell_val(cols[0])
        shareholding = cell_val(cols[3]).replace(",", "")

        # 只保留经纪商（ID 以 "B" 开头）
        if not pid.upper().startswith("B"):
            continue

        try:
            brokers[pid] = int(shareholding)
        except ValueError:
            continue

    return brokers


# ─────────────────────────────────────────
# Step 4: 生成 xlsx（数据表 + TOP10 条状图）
# ─────────────────────────────────────────
def export_xlsx(df: pd.DataFrame, output_path: str):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.chart import BarChart, Reference
    from openpyxl.utils import get_column_letter

    wb = Workbook()

    # ── Sheet 1：完整数据 ──
    ws1 = wb.active
    ws1.title = "持股变化数据"

    headers = list(df.columns)
    hdr_fill   = PatternFill("solid", start_color="1F4E79")
    hdr_font   = Font(name="Arial", bold=True, color="FFFFFF", size=10)
    alt_fill   = PatternFill("solid", start_color="EBF3FB")
    border_s   = Side(style="thin", color="CCCCCC")
    cell_bdr   = Border(left=border_s, right=border_s, top=border_s, bottom=border_s)

    for ci, col_name in enumerate(headers, 1):
        c = ws1.cell(row=1, column=ci, value=col_name)
        c.font      = hdr_font
        c.fill      = hdr_fill
        c.alignment = Alignment(horizontal="center", vertical="center")
        c.border    = cell_bdr

    for ri, row in enumerate(df.itertuples(index=False), 2):
        for ci, value in enumerate(row, 1):
            c = ws1.cell(row=ri, column=ci, value=value)
            c.font      = Font(name="Arial", size=10)
            c.alignment = Alignment(horizontal="center")
            c.border    = cell_bdr
            if ri % 2 == 0:
                c.fill = alt_fill

    for ci, col_name in enumerate(headers, 1):
        max_len = max(len(str(col_name)),
                      df.iloc[:, ci - 1].astype(str).map(len).max())
        ws1.column_dimensions[get_column_letter(ci)].width = min(max_len + 4, 35)
    ws1.freeze_panes = "A2"

    # ── Sheet 2：变化率 TOP10 条状图 ──
    ws2 = wb.create_sheet("变化率 TOP 10")

    df["_pct_num"] = df["最大变化率"].str.replace("%", "").str.replace("+", "").astype(float)
    top10 = df.nlargest(10, "_pct_num").sort_values("_pct_num", ascending=False)
    df.drop(columns=["_pct_num"], inplace=True)

    ws2["A1"] = "股票代号"
    ws2["B1"] = "最大变化率(%)"
    ws2["A1"].font = Font(name="Arial", bold=True)
    ws2["B1"].font = Font(name="Arial", bold=True)

    for i, (_, row) in enumerate(top10.iterrows(), 2):
        pct_val = float(row["最大变化率"].replace("%", "").replace("+", ""))
        ws2.cell(row=i, column=1, value=row["股票代号"]).font = Font(name="Arial", size=10)
        ws2.cell(row=i, column=2, value=pct_val).font        = Font(name="Arial", size=10)

    ws2.column_dimensions["A"].width = 14
    ws2.column_dimensions["B"].width = 16

    chart = BarChart()
    chart.type    = "bar"
    chart.title   = "变化率 TOP 10"
    chart.y_axis.title = "股票代号"
    chart.x_axis.title = "最大变化率(%)"
    chart.style   = 10
    chart.width   = 22
    chart.height  = 14

    chart.x_axis.scaling.logBase = 10
    chart.x_axis.scaling.min     = 1

    data_ref = Reference(ws2, min_col=2, min_row=1, max_row=len(top10) + 1)
    cats_ref = Reference(ws2, min_col=1, min_row=2, max_row=len(top10) + 1)
    chart.add_data(data_ref, titles_from_data=True)
    chart.set_categories(cats_ref)
    ws2.add_chart(chart, "D2")

    wb.save(output_path)
    print(f"  ✓ xlsx 已保存至 {output_path}")


# ─────────────────────────────────────────
# 主函数
# ─────────────────────────────────────────
def main():
    print("=" * 65)
    print("CCASS Inter-Broker Movement Analysis")
    print(f"查询页面 : {SEARCH_URL}")
    print(f"对比日期 : {DATE_OLD}  →  {DATE_NEW}")
    print(f"变化率阈值: >{THRESHOLD*100:.0f}%   股票数: {TOP_N if TOP_N else '全部'}")
    print("=" * 65)

    # Step 2: 获取股票列表
    stocks = fetch_stock_list(DATE_NEW, top_n=TOP_N)

    # Step 3: 分别查询两日持股
    print(f"\n[Step 3] 查询 {DATE_NEW} 各股票经纪商持股...")
    session, vs, vs_gn = get_session()
    holdings_new = {}
    for i, (code, name) in enumerate(stocks, 1):
        print(f"  [{i}/{len(stocks)}] {code} {name} @ {DATE_NEW}", end=" ... ", flush=True)
        brokers = fetch_broker_holdings(session, vs, vs_gn, code, DATE_NEW)
        holdings_new[code] = brokers
        print(f"{len(brokers)} brokers")
        time.sleep(0.3)

    print(f"\n[Step 4] 查询 {DATE_OLD} 各股票经纪商持股...")
    session, vs, vs_gn = get_session()
    holdings_old = {}
    for i, (code, name) in enumerate(stocks, 1):
        print(f"  [{i}/{len(stocks)}] {code} {name} @ {DATE_OLD}", end=" ... ", flush=True)
        brokers = fetch_broker_holdings(session, vs, vs_gn, code, DATE_OLD)
        holdings_old[code] = brokers
        print(f"{len(brokers)} brokers")
        time.sleep(0.3)

    # Step 5: 计算变化，筛选超过阈值的股票
    print("\n[Step 5] 计算经纪商持股变化...")
    records = []

    stock_dict = {code: name for code, name in stocks}

    for code in holdings_new:
        brokers_new = holdings_new.get(code, {})
        brokers_old = holdings_old.get(code, {})

        # 取两日都出现的经纪商
        common_brokers = set(brokers_new.keys()) & set(brokers_old.keys())
        if not common_brokers:
            continue

        max_pct   = 0.0
        max_pid   = ""
        triggered = False

        for pid in common_brokers:
            sh_new = brokers_new[pid]
            sh_old = brokers_old[pid]
            if sh_old == 0:
                continue
            pct = (sh_new - sh_old) / sh_old
            if abs(pct) > abs(max_pct):
                max_pct = pct
                max_pid = pid
            if abs(pct) > THRESHOLD:
                triggered = True

        if triggered:
            records.append({
                "股票代号":   code,
                "股票名称":   stock_dict.get(code, ""),
                "触发经纪商": max_pid,
                f"{DATE_OLD} 持股量": brokers_old.get(max_pid, 0),
                f"{DATE_NEW} 持股量": brokers_new.get(max_pid, 0),
                "最大变化率": f"{max_pct*100:+.2f}%",
            })

    if not records:
        print(f"\n✗ 没有股票的经纪商持股变化超过 {THRESHOLD*100:.0f}%")
        return

    df = pd.DataFrame(records)
    df["_pct"] = df["最大变化率"].str.replace("%", "").str.replace("+", "").astype(float)
    df = df.sort_values("_pct", ascending=False).drop(columns=["_pct"]).reset_index(drop=True)

    print(f"\n── 共 {len(df)} 只股票的经纪商持股变化超过 {THRESHOLD*100:.0f}% ──")
    print(df.to_string(index=False))

    # 保存 CSV
    csv_file = f"ccass_result_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    df.to_csv(csv_file, index=False, encoding="utf-8-sig")
    print(f"\n✓ CSV 已保存至 {csv_file}")

    # 生成 xlsx
    print("\n[Step 6] 生成 xlsx...")
    xlsx_file = f"ccass_result_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    export_xlsx(df.copy(), xlsx_file)


if __name__ == "__main__":
    main()