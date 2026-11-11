import hashlib,http.cookiejar,json,ssl,urllib.request
from pathlib import Path
root=Path.home()/'.local/share/market-watch-dev/updates/v2.0.6-20261111'
credentials=json.loads((root.parents[1]/"credentials.json").read_text())
base=credentials["base_url"]
cookies=http.cookiejar.CookieJar()
opener=urllib.request.build_opener(urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=credentials["ca_file"])),urllib.request.HTTPCookieProcessor(cookies))
csrf=""
def read(path,body=None):
    headers={"Content-Type":"application/json"}
    if body is not None and path!="/api/login": headers["x-csrf-token"]=csrf
    request=urllib.request.Request(base+path,headers=headers,data=None if body is None else json.dumps(body).encode())
    with opener.open(request,timeout=25) as response: return response.read()
def call(path,body=None): return json.loads(read(path,body))
assert call("/readyz")["status"]=="ready"
csrf=call("/api/login",{"password":credentials["login_password"]})["csrf"]
status=call("/api/market-data/dataset",{"instrument":"BTCUSDT","timeframe":"M1"})
assert status["coverage_projection"]["complete"]
assert not status["coverage_projection"]["maintenance_required"]
data=call("/api/charts/data",{"instrument":"BTCUSDT","timeframe":"M1","published":True,"limit":5})
assert len(data["bars"])==5 and all(bar["complete"] for bar in data["bars"])
health=call("/api/health")
manifest=call("/chart-assets.json")
local=root/"native-assets"
assert manifest==json.loads((local/"chart-assets.json").read_text())
assert hashlib.sha256(read("/"+manifest["script"])).digest()==hashlib.sha256((local/manifest["script"]).read_bytes()).digest()
report={"release":"v2.0.6","commit":"d2a3e0925175376746170e2597c6fa675d2fa43d","base_url":base,"ready":True,"https_login":True,"coverage_projection":status["coverage_projection"],"published_complete_bars":len(data["bars"]),"saved_workspaces":len(call("/api/advanced-charts/workspaces")),"saved_preferences":len(call("/api/advanced-charts/preferences")),"chart_alerts":len(call("/api/chart-alerts")),"native_asset_matches_release":True,"native_manifest":manifest,"runtime":{key:[dict(role=r["role"],state=r["state"],error=r.get("error_type")) for r in health[key]] for key in ["market_runtime","data_runtime","notification_runtime"]}}
(root/"http-smoke.json").write_text(json.dumps(report,indent=2,ensure_ascii=False))
print(json.dumps(report,ensure_ascii=False,indent=2))

assert all(r["state"] not in {"missing", "stale", "degraded", "failed"} and not r["error"] for rows in report["runtime"].values() for r in rows), "Runtime unhealthy"
