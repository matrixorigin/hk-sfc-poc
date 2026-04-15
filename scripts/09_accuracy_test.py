#!/usr/bin/env python3
"""
HK SFC POC 准确性测试

流式验证：并发发送查询，完成一条立即验证一条，任何失败立即取消其余并退出。

用法:
  python3 scripts/09_accuracy_test.py [-c CONCURRENCY] [-t FILTER]

参数:
  -c CONCURRENCY  并发数（默认 1）
  -t FILTER       只跑指定 sid（逗号分隔，如 "v1,b4"）
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import urllib.request
from concurrent.futures import CancelledError, ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

# ---------- 配置 ----------
PROJECT_DIR = Path(__file__).resolve().parent.parent
CASES_FILE = Path(__file__).resolve().parent / "accuracy_cases.tsv"

CATALOG_URL = os.environ.get("CATALOG_URL", "http://localhost:8084")
MO_HOST = os.environ.get("MO_HOST", "127.0.0.1")
MO_PORT = os.environ.get("MO_PORT", "16002")
MO_DB = "hk_sfc"
TABLES = [
    "ms_t_stk_hsi", "ms_v_stk_hsi_daily", "ms_t_stk_sis",
    "ms_v_stock_capital", "ds_t_int_hsicl_dtl", "sehknews",
    "profit_loss", "ccass_holdings",
]
OUT_DIR = Path("/tmp/poc_accuracy_test")
TIMEOUT = 180
KB_ID = 10001


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------- .env 加载 ----------
def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    env_file = PROJECT_DIR / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


ENV = load_env()
KEY = ENV.get("MOI_SYSTEM_API_KEY", "")
WS = ENV.get("POC_WORKSPACE_ID", "")

if not KEY or not WS:
    print("ERROR: MOI_SYSTEM_API_KEY / POC_WORKSPACE_ID 缺失，检查 .env", file=sys.stderr)
    sys.exit(1)


def get_workspace_account() -> str:
    req = urllib.request.Request(
        f"{CATALOG_URL}/api/v1/workspaces/{WS}",
        headers={"X-API-Key": KEY},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.load(resp)
    return data["data"]["account_name"]


ACCOUNT = get_workspace_account()
MO_USER = f"{ACCOUNT}:moi_core_system"
MO_PASS = KEY


# ---------- 用例定义 ----------
@dataclass
class Case:
    sid: str
    label: str
    question: str
    gt_sql: str
    checks: str = ""


def load_cases() -> list[Case]:
    cases: list[Case] = []
    for line in CASES_FILE.read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        cases.append(Case(
            sid=parts[0],
            label=parts[1],
            question=parts[2],
            gt_sql=parts[3],
            checks=parts[4] if len(parts) > 4 else "",
        ))
    return cases


# ---------- 执行 SQL ----------
def exec_mo(sql: str) -> tuple[int, str, Optional[str]]:
    """执行 SQL，返回 (行数, 原始 stdout, 错误信息或 None)。"""
    try:
        result = subprocess.run(
            [
                "mysql", "-h", MO_HOST, "-P", MO_PORT,
                "-u", MO_USER, f"-p{MO_PASS}",
                MO_DB, "-N", "-B", "-e", sql,
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return 0, "", "mysql timeout"
    except Exception as e:
        return 0, "", f"mysql error: {e}"

    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        return 0, "", f"mysql exit {result.returncode}: {stderr[:200]}"

    out = result.stdout or ""
    lines = [ln for ln in out.split("\n") if ln]
    return len(lines), out, None


# ---------- 发送查询 ----------
def fire(case: Case, cancel_event: threading.Event) -> Path:
    """通过 curl POST 到 Explore API 并把 SSE 响应写到 raw 文件。"""
    raw_path = OUT_DIR / f"{case.sid}.raw"
    if cancel_event.is_set():
        raw_path.write_text("CANCELLED")
        return raw_path

    payload = {
        "query": {"question": case.question},
        "session": {"session_id": case.sid, "workspace_id": WS},
        "data_sources": {
            "tables": {"db_name": MO_DB, "table_list": TABLES},
            "knowledge_bases": [{"knowledge_base_id": KB_ID}],
        },
        "options": {
            "planning_mode": "auto",
            "verbose": "steps",
            "llm": {"model": "qwen3-max"},
        },
    }
    data = json.dumps(payload, ensure_ascii=False)
    try:
        result = subprocess.run(
            [
                "curl", "-s", "-N",
                "--max-time", str(TIMEOUT),
                "-X", "POST",
                f"{CATALOG_URL}/api/v1/explore/query/stream",
                "-H", f"X-API-Key: {KEY}",
                "-H", "Content-Type: application/json",
                "-H", "Accept: text/event-stream",
                "-d", "@-",
            ],
            input=data,
            capture_output=True,
            text=True,
            timeout=TIMEOUT + 10,
        )
        raw_path.write_text(result.stdout or "")
    except subprocess.TimeoutExpired:
        raw_path.write_text("ERROR: curl subprocess hard timeout")
    except Exception as e:
        raw_path.write_text(f"ERROR: {e}")
    return raw_path


def extract_last_sql_result(raw_path: Path) -> Optional[dict]:
    """从 SSE 响应里抓最后一条带 sql 的 sql.result 事件。"""
    if not raw_path.exists():
        return None
    last = None
    for line in raw_path.read_text(errors="ignore").splitlines():
        if "sql.result" in line and "data: " in line:
            try:
                payload = json.loads(line.split("data: ", 1)[1])
                d = payload.get("data", {})
                if d.get("sql"):
                    last = d
            except (json.JSONDecodeError, KeyError):
                continue
    return last


def detect_query_error(raw_path: Path) -> Optional[str]:
    if not raw_path.exists():
        return "raw file missing"
    text = raw_path.read_text(errors="ignore")
    if text.startswith("ERROR:") or text == "CANCELLED":
        return text.strip() or "unknown error"
    if "run.error" in text:
        for line in text.splitlines():
            if "run.error" in line and "data: " in line:
                try:
                    payload = json.loads(line.split("data: ", 1)[1])
                    return (payload.get("data", {}).get("message") or "run.error")[:200]
                except (json.JSONDecodeError, KeyError):
                    return "run.error"
    return None


# ---------- 校验 ----------
def validate(case: Case, sql_result: dict) -> tuple[bool, str]:
    llm_sql: str = sql_result["sql"]
    llm_count, llm_out, llm_err = exec_mo(llm_sql)
    if llm_err:
        return False, f"LLM SQL 执行失败: {llm_err}"

    gt_count, gt_out, gt_err = exec_mo(case.gt_sql)
    if gt_err:
        return False, f"GT SQL 执行失败: {gt_err}"

    checks = case.checks or f"rows~{gt_count}"
    details = f"gt={gt_count} llm={llm_count}"

    for raw_check in checks.split(";"):
        check = raw_check.strip()
        if not check:
            continue

        if check.startswith("rows="):
            expected = int(check[len("rows="):])
            if llm_count != expected:
                return False, f"rows={llm_count}, expected={expected} ({details})"

        elif check.startswith("rows~"):
            expected = int(check[len("rows~"):])
            if expected == 0:
                if llm_count != 0:
                    return False, f"gt=0 but llm={llm_count} rows"
            else:
                lo = int(expected * 0.8)
                hi = int(expected * 1.2)
                if llm_count < lo or llm_count > hi:
                    return False, f"rows={llm_count}, expected={lo}~{hi} ({details})"

        elif check.startswith("contains="):
            vals = check[len("contains="):].split(",")
            for val in vals:
                if val and val not in llm_out:
                    return False, f"missing '{val}' ({details})"

        elif check.startswith("excludes="):
            vals = check[len("excludes="):].split(",")
            for val in vals:
                if val and val in llm_out:
                    return False, f"excluded value '{val}' present ({details})"

        elif check.startswith("sql_contains="):
            vals = check[len("sql_contains="):].split(",")
            for val in vals:
                if val and val not in llm_sql:
                    return False, f"SQL missing keyword '{val}'"

        elif check.startswith("precheck="):
            # case 自身的前置检查（在 runner 里处理），校验阶段跳过
            continue

        else:
            return False, f"未知 check 规则: {check}"

    return True, details


# ---------- 跑单个 case ----------
@dataclass
class Outcome:
    case: Case
    passed: bool
    message: str
    skipped: bool = False


def run_case(case: Case, cancel_event: threading.Event) -> Outcome:
    if cancel_event.is_set():
        return Outcome(case, False, "cancelled before start", skipped=True)

    # 处理 precheck（当前只支持 v5 那种"数据存在才跑"的场景）
    for raw_check in case.checks.split(";"):
        check = raw_check.strip()
        if check.startswith("precheck="):
            pre_sql = check[len("precheck="):]
            cnt, out, err = exec_mo(pre_sql)
            if err:
                return Outcome(case, False, f"precheck 失败: {err}")
            try:
                val = int(out.strip().split("\n")[0])
            except (ValueError, IndexError):
                val = 0
            if val == 0:
                return Outcome(case, True, "SKIP: precheck 返回 0", skipped=True)

    raw_path = fire(case, cancel_event)
    if cancel_event.is_set():
        return Outcome(case, False, "cancelled during fire", skipped=True)

    sql_result = extract_last_sql_result(raw_path)
    if sql_result is None:
        err = detect_query_error(raw_path) or "no sql.result in response (可能超时)"
        return Outcome(case, False, err)

    passed, msg = validate(case, sql_result)
    return Outcome(case, passed, msg)


# ---------- 主流程 ----------
def health_check() -> None:
    log("========== 环境检查 ==========")
    try:
        with urllib.request.urlopen(f"{CATALOG_URL}/health", timeout=5) as resp:
            status = json.load(resp).get("status", "unknown")
        print(f"  Catalog: {status}")
    except Exception as e:
        print(f"  Catalog: FAIL ({e})")
        sys.exit(1)

    cnt, out, err = exec_mo("SELECT 'ok'")
    if err:
        print(f"  DB: FAIL ({err})")
        sys.exit(1)
    print("  DB: ok")


def main() -> int:
    parser = argparse.ArgumentParser(description="HK SFC POC 准确性测试")
    parser.add_argument("-c", "--concurrency", type=int, default=1)
    parser.add_argument("-t", "--filter", default="")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for ext in ("*.raw", "*.result", "*.expected"):
        for f in OUT_DIR.glob(ext):
            try:
                f.unlink()
            except OSError:
                pass

    health_check()
    print(f"  并发: {args.concurrency}")

    all_cases = load_cases()
    if args.filter:
        keep = {s.strip() for s in args.filter.split(",") if s.strip()}
        cases = [c for c in all_cases if c.sid in keep]
        if not cases:
            log(f"filter '{args.filter}' 没匹配到任何 case")
            return 1
    else:
        cases = all_cases

    log("")
    log(f"========== 流式并发跑 (concurrency={args.concurrency}) ==========")
    for c in cases:
        log(f"  排队: {c.label}")

    cancel_event = threading.Event()
    passed_count = 0
    failed_count = 0
    skipped_count = 0
    total = 0
    first_failure: Optional[Outcome] = None

    log("")
    log("========== 验证结果（完成一条验一条，fail-fast） ==========")

    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        future_map = {executor.submit(run_case, c, cancel_event): c for c in cases}
        try:
            for fut in as_completed(future_map):
                try:
                    outcome = fut.result()
                except CancelledError:
                    continue
                except Exception as e:
                    case = future_map[fut]
                    outcome = Outcome(case, False, f"runner exception: {e}")

                if cancel_event.is_set() and outcome.skipped:
                    continue

                total += 1
                if outcome.skipped and outcome.passed:
                    skipped_count += 1
                    log(f"  ⏭️  {outcome.case.label} — {outcome.message}")
                    continue

                if outcome.passed:
                    passed_count += 1
                    log(f"  ✅ {outcome.case.label} — {outcome.message}")
                else:
                    failed_count += 1
                    log(f"  ❌ {outcome.case.label} — {outcome.message}")
                    first_failure = outcome
                    cancel_event.set()
                    for f, _ in future_map.items():
                        if not f.done():
                            f.cancel()
                    break
        except KeyboardInterrupt:
            cancel_event.set()
            for f, _ in future_map.items():
                if not f.done():
                    f.cancel()
            log("被中断")
            return 130

    log("")
    log("=" * 50)
    log(f"准确性测试: {passed_count} 通过 / {failed_count} 失败 / {skipped_count} 跳过 (共 {total})")
    log("=" * 50)

    if first_failure:
        log(f"首个失败 case: {first_failure.case.label}")
        log(f"  详情: {first_failure.message}")
        log(f"  raw 文件: {OUT_DIR}/{first_failure.case.sid}.raw")

    return 1 if failed_count > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
