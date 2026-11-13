"""Bundle the plain A06-derived assets; no Node/build framework or network needed."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
FROZEN = ROOT.parent / 'android-a-freeze-20261111'

shell = '''<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light"><title>守望 A07 · 可交互优化候选</title>
<style>__CSS__</style></head><body>
<div class="studio"><section class="device-wrap" aria-label="守望设计预览">
<div class="preview-caption"><span>A07 设计预览 · 模拟数据</span><div><button id="theme" class="plain" aria-label="切换主题"></button><button id="review-tools" class="plain" aria-expanded="false">审阅</button></div></div>
<div id="device" class="device" data-theme="dark" data-variant="A">
<header class="app-header" id="header"></header><main id="screen"></main>
<nav id="nav" class="bottom-nav" aria-label="主导航"></nav>
<div id="alert-notice" class="alert-notice" role="status" hidden></div>
<div id="operation-notice" class="operation-notice" role="alert" hidden></div>
<div id="toast" class="toast" role="status" hidden></div>
<dialog id="sheet" aria-labelledby="sheet-title"><div id="sheet-content"></div></dialog>
</div></section></div>
<div class="review-bar" aria-label="设计工具，不属于应用">
<select id="review-page" aria-label="预览页面">__PAGES__</select>
<select id="review-scene" aria-label="预览场景">__SCENES__</select>
<select id="review-sheet" aria-label="预览弹窗"><option value="">弹窗</option>__SHEETS__</select>
<button id="demo-recover">恢复</button><button id="reset">重置</button>
</div><script>__JS__</script></body></html>'''

pages = [('watch','自选'),('chart','图表'),('alerts','告警'),('center','数据'),('more','更多'),('login','登录')]
scenes = [('normal','正常'),('loading','启动有缓存'),('cold','首次加载'),('offline-empty','离线无缓存'),('empty','空列表'),('offline','手机离线'),('error','刷新失败'),('stale','行情陈旧'),('save-error','提交失败'),('conflict','并发冲突'),('expired','登录过期'),('ntfy-off','通知未配置')]
sheets = [('create','新建告警'),('edit','编辑告警'),('search','搜索品种'),('groups','自选分组'),('manage','管理自选'),('detail','数据详情'),('rule','告警详情'),('events','通知记录'),('sources','来源状态'),('indicators','指标'),('theme','主题'),('connection','连接'),('capability','不支持告警'),('saved','保存成功'),('storage','存储失败'),('notification','浮动通知'),('discard','放弃修改'),('conflict','冲突反馈'),('failure','失败反馈')]
def options(items): return ''.join(f'<option value="{v}">{t}</option>' for v,t in items)
html = shell.replace('__PAGES__',options(pages)).replace('__SCENES__',options(scenes)).replace('__SHEETS__',options(sheets))
css = '\n'.join((ROOT/f).read_text() for f in ['base.css','design.css','refinement.css'])
js = '\n'.join((ROOT/f).read_text() for f in ['fixtures.js','app.js','refinement.js'])
(ROOT/'preview.html').write_text(html.replace('__CSS__',css).replace('__JS__',js))

# Comparison harness uses unmodified A06 behavior and styles inside the same viewport.
original = (FROZEN/'index.html').read_text()
original = re.sub(r'<link rel="stylesheet" href="\./(base|design)\.css">',lambda m:'<style>'+(FROZEN/(m[1]+'.css')).read_text()+'</style>',original)
original = re.sub(r'<script src="\./(fixtures|app)\.js"></script>',lambda m:'<script>'+(FROZEN/(m[1]+'.js')).read_text().replace('mw-android-preview-a05','mw-android-preview-a07-baseline')+'</script>',original)
original = original.replace('./assets/','../android-a-freeze-20261111/assets/')
original = original.replace('</head>','''<style>
.intro,.preview-caption,.device-note,.review-bar,.statusbar,.homebar{display:none!important}
.studio{display:block;padding:0;min-height:0}.device-wrap{width:100%}
.device{height:100dvh;width:100%;border:0;border-radius:0;box-shadow:none}
</style></head>''')
original = original.replace('</body>', '''<script>
state.theme=new URLSearchParams(location.search).get('theme')==='light'?'light':'dark';
state.noticeDismissed=new URLSearchParams(location.search).get('notice')!=='1';render();
</script></body>''')
(ROOT/'baseline.html').write_text(original)
print('Built preview.html (self-contained) and baseline.html (A06 comparison harness).')
