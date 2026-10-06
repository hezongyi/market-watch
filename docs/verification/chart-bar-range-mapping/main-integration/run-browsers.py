import os,subprocess,json,pathlib
root="/home/quant/repos/market-watch-range-main"
env=dict(os.environ,RANGE_APP="https://192.168.7.232:16843",RANGE_CHART="https://192.168.7.232:16844",RANGE_LOGIN="/home/quant/repos/.acceptance/range-main-20261006/login.json",LD_LIBRARY_PATH="/tmp/mw-v170-browser-deps/root/usr/lib/x86_64-linux-gnu")
paths=[("advanced-sync-settings","main"),("advanced-sync-settings-choices","choices"),("advanced-sync-settings-extended","extended"),("advanced-sync-settings-touch","touch"),("advanced-sync-settings-geometry","geometry"),("advanced-sync-settings-modal","modal"),("advanced-sync-settings-menu","menu"),("advanced-sync-settings-legacy","legacy"),("advanced-range-v180-stability","stability"),("advanced-bar-range-mapping","mapping"),("advanced-bar-range-lifecycle","lifecycle"),("advanced-bar-range-navigation","navigation"),("advanced-bar-range-matrix","matrix"),("advanced-bar-range-calendar","calendar")]
results=[]
for path,name in paths[int(os.environ.get("BROWSER_START","0")):int(os.environ.get("BROWSER_END",str(len(paths))))]:
 subprocess.run(["node","/tmp/mw-range-main/set-capacity.cjs", "20000" if name == "legacy" else "200000"],env=env,cwd=root,check=True)
 env["RANGE_SETTLE_TIMEOUT"] = "180000" if name == "navigation" else "60000"
 env["RANGE_OUTPUT"]=f"/tmp/mw-range-main/final-{name}.json"
 r=subprocess.run(["node",f"web/tests/{path}.browser.cjs"],env=env,cwd=root)
 print(name,r.returncode,flush=True);results.append(dict(name=name,exit=r.returncode))
 pathlib.Path("/tmp/mw-range-main/browser-runs.json").write_text(json.dumps(results,indent=2))
 if r.returncode:break
