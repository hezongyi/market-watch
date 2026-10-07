import os,subprocess
root="/home/quant/repos/market-watch-range-main"
env=dict(os.environ,NATIVE_SYNC_APP="https://192.168.7.232:16843",NATIVE_SYNC_CHART="https://192.168.7.232:16844",NATIVE_SYNC_LOGIN="/home/quant/repos/.acceptance/range-main-20261006/login.json",NATIVE_SYNC_COMPOSE="/home/quant/repos/.acceptance/range-main-20261006/compose.yaml",NATIVE_SYNC_OUTPUT="/tmp/mw-range-main/final-native-continuous.json",PLAYWRIGHT_CHROMIUM_EXECUTABLE="/home/quant/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",LD_LIBRARY_PATH="/tmp/mw-v170-browser-deps/root/usr/lib/x86_64-linux-gnu",COUNTS="4",CONTINUOUS_FULL="1",NATIVE_REVISION_SCRIPT="1",NATIVE_PREFIX_REVISION="1")
if os.environ.get("NATIVE_BOUNDARY_ONLY") == "1":
 env.update(NATIVE_SYNC_OUTPUT="/tmp/mw-range-main/final-native-boundary.json", CONTINUOUS_FULL="0", NATIVE_REVISION_SCRIPT="", NATIVE_PREFIX_REVISION="0")
try:
 with open(env["NATIVE_SYNC_OUTPUT"].replace(".json",".log"),"w") as log:
  r=subprocess.run(["node","web/tests/advanced-native-continuous.product.browser.cjs"],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
 exit_code=r.returncode
 print("native continuous product",exit_code,flush=True)
finally:
 r=subprocess.run(["sg","docker","-c","docker compose -f /home/quant/repos/.acceptance/range-main-20261006/compose.yaml exec -T --user 0 api python /private/revise.py restore"],capture_output=True,text=True)
 print("fixture restoration",r.returncode,r.stdout,r.stderr,flush=True)

raise SystemExit(exit_code or r.returncode)
