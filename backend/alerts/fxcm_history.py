"""Finite BID snapshots through the private ForexConnect native helper.

Construction and local directory reads never start a process or log in. Each
adapter owns a demand-driven session, which logs out after 20 idle seconds.
Credentials cross stdin only; SDK diagnostics stay in a private temporary dir.
"""

import hashlib
import json
import os
import re
import selectors
import subprocess
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from threading import RLock

from .config import settings
from .market_contracts import (
    CandleBatch,
    MarketRequestError,
    MinuteRow,
    RequestResult,
    failed_request,
)
from .market_resources import cooldown, request_slot
from .storage import ms, now_ms

URL = "https://www.fxcorporate.com/Hosts.jsp"
FRAMES = {"M1": "m1", "M5": "m5", "M15": "m15", "M30": "m30",
          "H1": "H1", "H4": "H4", "D1": "D1", "W1": "W1", "MN": "M1"}


def credentials():
    """Read bounded local secret material; never retain supplier error text."""
    try:
        path = Path(settings.fxcm_credentials_file)
        if path.stat().st_mode & 0o077 or path.stat().st_size > 16384:
            raise ValueError
        raw = json.loads(path.read_text())
        user, password = raw["username"], raw["password"]
        if (not all(isinstance(v, str) and 0 < len(v) <= 256 and
                    not any(c in v for c in "\r\n\0") for v in (user, password))
                or raw.get("connection", "demo").lower() != "demo"
                or raw.get("url") not in (None, "", URL)):
            raise ValueError
        return user, password
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise ValueError("FXCM模拟账户私有凭据配置无效") from None


def account_scope():
    user, _ = credentials()
    return "sha256:" + hashlib.sha256(("fxcm|forexconnect|demo|" + user).encode()).hexdigest()


def configured():
    if not settings.fxcm_enabled or not settings.fxcm_helper_path or not settings.fxcm_sdk_path:
        return False
    try:
        credentials()
        return Path(settings.fxcm_helper_path).is_file() and Path(settings.fxcm_sdk_path).is_dir()
    except ValueError:
        return False


def _cancelled():
    from .provider_cache import check_cancelled
    check_cancelled()


class FxcmHistory:
    def __init__(self, *, clock=None, cancel=None):
        self.clock = clock or now_ms
        self.cancel = cancel or _cancelled
        self.process = None
        self.directory = None
        self.buffer = b""
        self.scope = None
        self.lock = RLock()

    @contextmanager
    def _locked(self, deadline):
        while not self.lock.acquire(timeout=.1):
            self.cancel()
            if time.monotonic() >= deadline:
                raise TimeoutError("FXCM历史请求超时")
        try:
            yield
        finally:
            self.lock.release()

    def close(self):
        with self.lock:
            process, self.process = self.process, None
            if process is not None:
                try:
                    process.stdin.close()
                except OSError:
                    pass
                try:
                    process.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    try:
                        process.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=1)
                process.stdout.close()
            if self.directory is not None:
                self.directory.cleanup()
                self.directory = None
            self.buffer = b""
            self.scope = None

    def _line(self, deadline):
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            while b"\n" not in self.buffer:
                self.cancel()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("FXCM历史请求超时")
                if not selector.select(min(.1, remaining)):
                    continue
                chunk = os.read(self.process.stdout.fileno(), 4096)
                if not chunk:
                    raise RuntimeError("FXCM历史连接已结束")
                self.buffer += chunk
                if len(self.buffer) > 65536:
                    raise ValueError("FXCM响应过大")
        raw, self.buffer = self.buffer.split(b"\n", 1)
        try:
            row = json.loads(raw)
        except (ValueError, UnicodeError):
            raise ValueError("FXCM响应格式无效") from None
        if not isinstance(row, dict):
            raise ValueError("FXCM响应格式无效")
        if row.get("kind") == "error":
            auth = row.get("code") == "auth"
            cooldown("fxcm", retry_seconds=300 if auth else 60)
            raise MarketRequestError(RequestResult(status="unauthorized" if auth else "unavailable",
                reason_code="AUTH" if auth else "UNKNOWN"))
        return row

    def _start(self, scope, deadline):
        if self.process is not None and (self.process.poll() is not None or self.scope != scope):
            self.close()
        if self.process is not None:
            return
        if not configured():
            raise ValueError("请先启用并配置FXCM历史连接")
        user, password = credentials()
        actual_scope = "sha256:" + hashlib.sha256(("fxcm|forexconnect|demo|" + user).encode()).hexdigest()
        if actual_scope != scope:
            raise ValueError("FXCM账户配置已变化，请重新选择")
        self.directory = tempfile.TemporaryDirectory(prefix="mw-fxcm-")
        self.process = subprocess.Popen([settings.fxcm_helper_path], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
            cwd=self.directory.name, env={"PATH": "/usr/bin:/bin",
                "HOME": self.directory.name, "LANG": "C.UTF-8",
                "LD_LIBRARY_PATH": str(Path(settings.fxcm_sdk_path) / "lib")})
        self._write((user + "\n" + password + "\n" + URL + "\nDemo\n").encode())
        self.scope = scope
        if self._line(deadline) != {"kind": "ready"}:
            raise ValueError("FXCM登录协议无效")

    def _write(self, data):
        while data:
            written = self.process.stdin.write(data)
            if not written:
                raise RuntimeError("FXCM历史连接已结束")
            data = data[written:]

    def _request(self, command, *, expected, limit, deadline=None, scope=None):
        deadline = deadline or time.monotonic() + 65
        with self._locked(deadline):
            self.cancel()
            # Covers login, the snapshot and error cleanup across all workers.
            def cancelled():
                self.cancel()
                return False
            with request_slot("fxcm", deadline=deadline, cancelled=cancelled):
                try:
                    current_scope = account_scope()
                    if scope is not None and scope != current_scope:
                        raise ValueError("FXCM账户配置已变化，请重新选择")
                    self._start(current_scope, deadline)
                    self._write(command.encode())
                    rows = []
                    while True:
                        row = self._line(deadline)
                        if row == {"kind": "done"}:
                            return rows
                        if row.get("kind") != expected or len(rows) >= limit:
                            raise ValueError("FXCM响应类型或条数无效")
                        rows.append(row)
                except BaseException:
                    self.close()
                    raise

    def catalog(self):
        rows = self._request("catalog\n", expected="instrument", limit=10000)
        seen = set()
        for row in rows:
            symbol = row.get("symbol")
            if (not isinstance(symbol, str) or not 0 < len(symbol) <= 64
                    or any(ord(c) < 32 for c in symbol) or symbol in seen
                    or type(row.get("digits")) is not int or not 0 <= row["digits"] <= 10
                    or type(row.get("instrument_type")) is not int):
                raise ValueError("FXCM目录无效")
            seen.add(symbol)
        return rows

    def timeframes(self):
        """Session capabilities, refreshed explicitly alongside the local directory."""
        rows = self._request("timeframes\n", expected="timeframe", limit=1000)
        depths = {}
        for row in rows:
            ident, depth = row.get("id"), row.get("query_depth")
            if not isinstance(ident, str) or type(depth) is not int or ident in depths:
                raise ValueError("FXCM周期目录无效")
            depths[ident] = depth
        return {frame: min(300, depths[native]) for frame, native in FRAMES.items()
                if depths.get(native, -1) > 0}

    def bars(self, symbol, frame, start, end, digits, *, count=300, deadline=None, scope=None):
        if (frame not in FRAMES or not 0 <= start < end or not 1 <= count <= 300
                or type(digits) is not int or not 0 <= digits <= 10
                or not isinstance(symbol, str) or not 0 < len(symbol) <= 64
                or any(ord(c) < 32 for c in symbol)):
            raise ValueError("无效的FXCM历史请求")
        # Leave a guard month at the oldest page edge: ForexConnect can split
        # a native month at DST and cut a fragment at the request-count limit.
        requested = min(300, count + 2) if frame == "MN" else count
        command = (f"bars\n{symbol}\n{FRAMES[frame]}\n"
                   f"{digits} {start / 86400000 + 25569:.12f} "
                   f"{end / 86400000 + 25569:.12f} {requested}\n")
        raw = self._request(command, expected="candle", limit=requested, deadline=deadline, scope=scope)
        from datetime import datetime
        from decimal import Decimal

        from .domain import Candle
        from .storage import instant

        rows, seen = [], set()
        observed = self.clock()
        for row in raw:
            try:
                stamp_raw = row["time"]
                if not isinstance(stamp_raw, str) or not re.fullmatch(
                        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", stamp_raw):
                    raise ValueError
                stamp = ms(datetime.fromisoformat(stamp_raw.replace("Z", "+00:00")))
                prices = {key: row[key] for key in ("open", "high", "low", "close")}
                volume = row["volume"]
            except (KeyError, TypeError, ValueError):
                raise ValueError("FXCM历史柱无效") from None
            if (any(not isinstance(p, str) for p in prices.values())
                    or (stamp in seen and frame != "MN") or stamp % 60000
                    or stamp > observed or type(volume) is not int or not 0 <= volume <= 2147483647
                    or any(len(p) > 40 or not re.fullmatch(r"[0-9]+(?:[.][0-9]+)?", p)
                           or len(p.partition(".")[2]) > digits
                           for p in prices.values())):
                raise ValueError("FXCM历史柱无效")
            Candle(instant(stamp), instant(stamp + 60000),
                   *(Decimal(value) for value in prices.values()), volume=Decimal(row["volume"]))
            seen.add(stamp)
            # Snapshot `to` can include the boundary bar (observed on XAU D1).
            # Validate every returned bar, then enforce our [start, end) contract.
            if start <= stamp < end:
                rows.append({"start": stamp, **prices, "volume": str(row["volume"])})
        rows.sort(key=lambda row: row["start"])
        if frame == "MN":
            rows = assemble_native_months(rows)
            if len(raw) == requested and rows:
                rows = rows[1:]  # Oldest month may be a count-truncated fragment.
        return rows[-count:]


    def page(self, identity, start, end):
        if ((identity.source, identity.channel, identity.environment, identity.basis) !=
                ("fxcm", "forexconnect", "demo", "bid") or identity.account_scope != account_scope()):
            raise ValueError("FXCM模拟账户历史BID身份不匹配")
        if not 0 <= start < end or end - start > 300 * 60000 or start % 60000 or end % 60000:
            raise ValueError("FXCM M1请求最多300个整分钟")
        from .provider_fxcm import symbol_metadata
        meta = symbol_metadata(identity.provider_symbol)
        try:
            # A fully empty bounded interval can fail at FXCM (observed over
            # the weekend). A finite snapshot before the cutoff succeeds and
            # can be clipped locally. Exclude `end` upstream too: an inclusive
            # boundary must not consume one of the 300 requested M1 slots.
            raw = self.bars(identity.provider_symbol, "M1", 0, end - 1, meta["precision"],
                            scope=identity.account_scope)
            observed = self.clock()
            rows = tuple(MinuteRow(timestamp=row["start"],
                **{key: row[key] for key in ("open", "high", "low", "close", "volume")},
                complete=row["start"] + 60000 <= observed) for row in raw
                if start <= row["start"] < end)
            return CandleBatch(identity=identity, window_start=start, window_end=end,
                observed_at=observed, rows=rows, checkpoint=end, volume_kind="tick_count",
                volume_unit="price_changes", result=RequestResult(status="data" if rows else "empty_success"))
        except (RuntimeError, TimeoutError, ValueError, OSError, KeyError, TypeError) as error:
            observed = self.clock()
            return CandleBatch(identity=identity, window_start=start, window_end=end,
                observed_at=observed, checkpoint=start, volume_kind="tick_count",
                volume_unit="price_changes", result=failed_request(error, observed_at=observed))


def assemble_native_months(rows):
    """Join same-label native month fragments, preserving every source payload.

    ForexConnect snapshots can return two DST fragments with the same month
    label in reverse order. PreviousClose provides a unique price chain. This
    only joins that native month; it never derives OHLC from another timeframe.
    Ambiguous/disconnected source records remain an explicit failure.
    """
    from decimal import Decimal
    from itertools import groupby

    result = []
    for _, group in groupby(rows, key=lambda row: row["start"]):
        parts = list(group)
        if len(parts) == 1:
            result.append(parts[0])
            continue
        if len(parts) != 2:
            raise ValueError("FXCM月线同时间记录无法唯一拼接")
        left, right = parts
        forward = Decimal(left["close"]) == Decimal(right["open"])
        reverse = Decimal(right["close"]) == Decimal(left["open"])
        if forward == reverse:
            raise ValueError("FXCM月线同时间记录无法唯一拼接")
        first, last = (left, right) if forward else (right, left)
        result.append({**first, "high": max(parts, key=lambda r: Decimal(r["high"]))["high"],
            "low": min(parts, key=lambda r: Decimal(r["low"]))["low"], "close": last["close"],
            "volume": str(sum(int(row["volume"]) for row in parts)),
            "native_fragments": [first, last],
            "native_assembly": "same_month_previous_close_chain_v1"})
    return result
