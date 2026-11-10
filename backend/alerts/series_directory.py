"""Canonical series-directory query seam.

Platform, self-built (published fixed history), composite and compatibility
searches share one paging and cursor implementation. Provider rows are supplied
by a small adapter so legacy tests and callers keep their existing seam.
"""

from fastapi import HTTPException

from .storage import transaction


def page(query="", *, kind="history", page_size=25, offset=0, source=None, calendar=None,
          symbol_type="", cursor=None, include_total=True, provider_page=None):
    from .search_types import TYPES
    if (kind not in ("all", "provider", "history", "composite") or symbol_type not in TYPES
            or not 1 <= page_size <= 250 or not 0 <= offset <= 1000000
            or source not in (None, "dukascopy", "oanda", "binance", "yahoo", "akshare", "fxcm")
            or calendar not in (None, "ny17", "utc0", "source_date")):
        raise HTTPException(422, "无效行情搜索分页或筛选")
    if kind == "all":
        if offset:
            raise HTTPException(422, "全类别搜索请使用游标翻页")
        return _all_page(query, page_size=page_size, source=source, calendar=calendar,
                        symbol_type=symbol_type, cursor=cursor, provider_page=provider_page)
    if cursor:
        raise HTTPException(422, "此搜索范围不接受游标")
    if kind == "provider":
        if calendar:
            raise HTTPException(422, "平台搜索不接受自建聚合日界")
        if provider_page is None:
            from .market_data import _provider_series_page as provider_page
        return provider_page(query, source=source, symbol_type=symbol_type,
                             offset=offset, page_size=page_size, include_total=include_total)
    from .series_access import search_page
    try:
        with transaction() as db:
            return search_page(db, query, kind=kind, page_size=page_size, offset=offset,
                               source=source, calendar=calendar, symbol_type=symbol_type)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None


def _all_page(query, *, page_size, source, calendar, symbol_type, cursor, provider_page=None):
    """Fair merge of three pure searches. Cursor advances through candidates,
    including invalid mappings, without losing the unconsumed part of a page.
    Each managed branch retains its bounded qualification scan.
    """
    import base64
    import binascii
    import hashlib
    import json

    from .series_access import search_page

    signature = hashlib.sha256(json.dumps([query, source, calendar, symbol_type]).encode()).hexdigest()[:16]
    positions, turn = [0, 0, 0], 0
    if cursor:
        try:
            if len(cursor) > 300:
                raise ValueError()
            state = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
            positions, turn = state["p"], state["t"]
            if (state["s"] != signature or len(positions) != 3 or type(turn) is not int or not 0 <= turn < 3
                    or any(p is not None and (type(p) is not int or not 0 <= p <= 1000000) for p in positions)):
                raise ValueError()
        except (ValueError, KeyError, TypeError, UnicodeError, binascii.Error):
            raise HTTPException(422, "无效搜索游标") from None
    p = positions[0] or 0
    if provider_page is None:
        from .market_data import _provider_series_page as provider_page
    provider_result = (provider_page(query, source=source, symbol_type=symbol_type,
        offset=p, page_size=page_size, include_total=False) if positions[0] is not None and not calendar
        else {"items": [], "next_offset": None})
    pages = [{**provider_result, "item_offsets": list(range(p + 1, p + len(provider_result["items"]) + 1))}]
    with transaction() as db:
        for i, kind in enumerate(("history", "composite"), 1):
            pages.append(search_page(db, query, kind=kind, page_size=page_size, offset=positions[i],
                         source=source, calendar=calendar, symbol_type=symbol_type)
                         if positions[i] is not None else {"items": [], "next_offset": None})
    for i, page in enumerate(pages):
        if not page["items"]:
            positions[i] = page["next_offset"]
    indices, items = [0, 0, 0], []
    for _ in range(page_size * 3):
        i = turn
        turn = (turn + 1) % 3
        page = pages[i]
        if indices[i] < len(page["items"]):
            items.append(page["items"][indices[i]])
            positions[i] = page["item_offsets"][indices[i]]
            indices[i] += 1
        if indices[i] == len(page["items"]):
            positions[i] = page["next_offset"]
        if len(items) == page_size or all(indices[j] == len(pages[j]["items"]) for j in range(3)):
            break
    has_more = any(p is not None for p in positions)
    next_cursor = base64.urlsafe_b64encode(json.dumps({"p": positions, "t": turn, "s": signature}, separators=(",", ":")).encode()).decode().rstrip("=") if has_more else None
    return {"items": items, "has_more": has_more, "next_cursor": next_cursor}


def search(query="", *, kind="all", limit=100, source=None, calendar=None, provider_page=None):
    """Compatibility list response; ranking and merging belong to paged search."""
    if kind not in ("all", "provider", "history", "composite") or not 1 <= limit <= 250:
        raise HTTPException(422, "无效行情搜索范围")
    if kind == "all" and (source or calendar):
        raise HTTPException(422, "筛选请明确平台、自建或组合范围")
    return page(query, kind=kind, page_size=limit, source=source,
                 calendar=calendar, include_total=False, provider_page=provider_page)["items"]
