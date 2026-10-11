"""Make a portable reference gallery from successful native UI browser evidence.

Requires Pillow. Crops preserve source pixels; no similarity score is claimed.
"""

import argparse
import html
import json
from pathlib import Path

from PIL import Image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--references", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = json.loads((args.evidence / "result.json").read_text())
    if result.get("passed") is not True:
        raise SystemExit("Only successful integration evidence may be published")
    snip = "Snipaste_2026-10-05_"
    shot = "ScreenShot_2026-10-05_"
    entries = [
        (snip + "06-43-41.png", "context-native-menu.png", "右键入口", "保留原生菜单与点击价格；主站交易、订单等其他菜单不在范围内。", "context"),
        (snip + "06-44-12.png", "create-initial.png", "创建", "480px 原生窗口、两列条件与摘要。现有行情/判定选项保留在高级区；无多条件。", "dialog"),
        (snip + "06-44-26.png", "condition-native-menu.png", "条件关系", "真实 Select/Listbox；关系仅展示现有上穿、下穿、区间等能力。", "dialog"),
        (snip + "06-44-49.png", "trigger-native-menu.png", "触发次数", "真实 Select；仅一次或有限次数，未把截图的“每次”解释为无限触发。", "dialog"),
        (snip + "06-45-03.png", "expiry-native-menu.png", "到期", "真实 PopupMenu 提供现有日期快捷项；高级区使用浏览器 datetime-local 日期输入。", "dialog"),
        (snip + "06-45-20.png", "notifications-dark.png", "通知", "真实 Checkbox；只展示网页及既有 ntfy，保留迟到事件语义。", "dialog"),
        (snip + "06-45-37.png", "message-dark.png", "消息", "真实 InputControl/Textarea/Button；应用只更新草稿，取消还原子页。占位符为现有集合。", "dialog"),
        (snip + "06-45-55.png", "sidebar-dark.png", "列表", "真实侧栏与拖宽；自有两行业务内容，显示实际健康状态和数量。", "sidebar"),
        (snip + "06-46-12.png", "sort-native-menu.png", "排序", "真实 PopupMenu/MenuItem/Separator；排序字段对应已有列表数据。", "sidebar"),
        (snip + "06-46-22.png", "more-native-menu.png", "列表更多", "真实 PopupMenu；筛选与状态操作使用现有语义，无清空业务。", "sidebar"),
        (snip + "06-46-31.png", "log-compact.png", "日志", "按日分组的自有业务内容；保留证据、迟到和投递状态。", "sidebar"),
        (snip + "06-46-43.png", "log-native-menu.png", "日志更多", "真实 PopupMenu；独立日志排序/筛选，未新增日志删除接口。", "sidebar"),
        (shot + "064716_832.png", "sidebar-hover.png", "悬停与详情", "原生容器内的自有操作和展开详情；没有复制官网 tooltip 的全部展示。", "sidebar"),
        (shot + "064741_323.png", "search-dark.png", "搜索", "按需展开的 HTML 搜索输入，键盘可达；搜索尚未使用供应商 InputControl。", "sidebar"),
        (shot + "064754_265.png", "log-dark.png", "日志选中", "选中行展开现有证据，确认通知不改变告警生命周期；没有新增日志删除。", "sidebar"),
        (shot + "064822_495.png", "edit-dark.png", "编辑", "原生窗口/输入/按钮；底部删除调用既有 archive，不物理删除规则。", "dialog"),
        (shot + "064832_420.png", "edit-dark.png", "编辑预设边界", "只对照窗口与删除位置。预设保存、重置菜单属于范围外，未实现或伪装。", "dialog"),
    ]
    assets = args.output / "comparison"
    assets.mkdir(parents=True, exist_ok=True)
    rows, cards = [], []
    for index, (ref, current, title, note, kind) in enumerate(entries, 1):
        reference = Image.open(args.references / ref)
        actual = Image.open(args.evidence / current)
        dimensions = list(reference.size)
        if reference.width == 2744:
            if kind == "dialog":
                box = (1100, 140, 1644, 760)
                reference = reference.crop(box)
                actual = actual.crop(box)
            elif kind == "sidebar":
                box = (2334, 28, 2744, 728)
                reference = reference.crop(box)
                actual = actual.crop(box)
            else:
                reference = reference.crop((2040, 416, 2420, 890))
                actual = actual.crop((430, 70, 810, 544))
        else:
            width, height = reference.size
            if kind == "dialog":
                left = 1372 - width // 2
                top = 445 - height // 2
            else:
                left, top = 2744 - width, 28
            actual = actual.crop((left, top, left + width, top + height))
        assert reference.size == actual.size
        ref_name, actual_name = f"{index:02}-reference.png", f"{index:02}-actual.png"
        reference.save(assets / ref_name)
        actual.save(assets / actual_name)
        rows.append(dict(reference=ref, current=current, title=title, difference=note,
                         reference_dimensions=dimensions, crop_dimensions=list(reference.size)))
        cards.append(f'''<article id="scene-{index}"><h2>{index:02} · {html.escape(title)}</h2>
<p>{html.escape(note)}</p><small>{html.escape(ref)} → {html.escape(current)} · 裁剪 {reference.width}×{reference.height}，原始像素</small>
<div class="pair"><figure><figcaption>参考</figcaption><a href="comparison/{ref_name}"><img loading="lazy" src="comparison/{ref_name}" alt="{html.escape(title)}参考"></a></figure>
<figure><figcaption>实施</figcaption><a href="comparison/{actual_name}"><img loading="lazy" src="comparison/{actual_name}" alt="{html.escape(title)}实施"></a></figure></div></article>''')
    (args.output / "comparison.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n")
    (args.output / "comparison.html").write_text('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Market Watch 告警参考图对照</title>
<style>body{margin:0;padding:24px;color:#dedede;background:#151515;font:15px/1.6 system-ui,sans-serif}main{max-width:1280px;margin:auto}h1{font-size:26px}h2{font-size:19px;margin:0}p{max-width:960px}small{color:#aaa}article{padding:22px;margin:24px 0;background:#202020;border:1px solid #424242;border-radius:8px;scroll-margin:24px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:16px}figure{margin:0;min-width:0}figcaption{margin-bottom:8px;color:#aaa}img{max-width:100%;height:auto;display:block}a{color:#86b9ff}@media(max-width:760px){body{padding:12px}.pair{grid-template-columns:1fr}}</style>
<main><h1>原生告警 UI · 17 张参考图对照</h1><p>Ubuntu 无头 Chromium，2744×890、DPR 1、真实 v31.1.0 许可库、模拟行情与父页面 API。本页截图证明界面与交互接入；真实 Docker 实例的另行验收结果见 README。两侧等尺寸裁剪保留原始像素，点击可查看 PNG。参考不是同一行情、数据或库功能集，没有计算像素相似百分比。</p><p>完整截图及复用/验证记录见 <a href="README.md">README.md</a>。已实现范围：右侧入口、列表、日志、创建/编辑、消息和通知。邮件、Webhook、多条件及预设未新增。</p>''' + "\n".join(cards) + "</main></html>\n")
    print(f"Generated {len(rows)} same-size reference pairs")


if __name__ == "__main__":
    main()
