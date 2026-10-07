import os,subprocess,json,pathlib
root="/home/quant/repos/market-watch-range-main"
env=dict(os.environ,APP_ORIGIN="https://192.168.7.232:16843",CHART_ORIGIN="https://192.168.7.232:16844",MW_MCP_PRIVATE_DIR="/home/quant/repos/.acceptance/range-main-20261006",MW_ALERT_PRIVATE_DIR="/home/quant/repos/.acceptance/range-main-20261006",MW_MCP_DRAWING_OUTPUT="/tmp/mw-range-main/mcp-drawings.json",PLAYWRIGHT_CHROMIUM_EXECUTABLE="/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",LD_LIBRARY_PATH="/tmp/mw-v170-browser-deps/root/usr/lib/x86_64-linux-gnu")
for script,name in [("native-mcp-drawings","mcp-drawings-final"),("chart-alerts-runtime","alerts-final")]:
 with open(f"/tmp/mw-range-main/{name}.log","w") as log:r=subprocess.run(["node",f"web/tests/{script}.browser.cjs"],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
 print(name,r.returncode,flush=True)
 if r.returncode:raise SystemExit(r.returncode)
 if script == "chart-alerts-runtime":
  import shutil
  shutil.copy2(env["MW_ALERT_PRIVATE_DIR"]+"/runtime-browser.json", "/tmp/mw-range-main/runtime-browser.json")
