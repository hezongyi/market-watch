import json,ssl,urllib.request,urllib.error,pathlib,hashlib,subprocess
root=pathlib.Path(__file__).resolve().parent
repo=root.parents[2]
base='https://192.168.7.232:18447'
ctx=ssl.create_default_context(cafile=str(repo/'mobile/client/app/src/debug/res/raw/android_personal_dev_ca.pem'))
client=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ctx))
def read(route):
 with client.open(base+route,timeout=30) as r:
  assert r.status==200,route
  return r.read(),r.headers
html,_=read('/m/')
assert b'user-scalable=no' in html
manifest=json.loads(read('/m/shell-manifest.json')[0])
assert manifest['version']==json.loads((repo/'web/dist/m/shell-manifest.json').read_text())['version']
for file in manifest['files']:read(file)
assert manifest['version'].encode() in read('/m/sw.js')[0]
read('/readyz')
update,headers=read('/downloads/android-update.json')
assert 'no-store' in headers.get('cache-control','')
update=json.loads(update)
apk=read('/downloads/'+update['apk'])[0]
assert len(apk)==update['size'] and hashlib.sha256(apk).hexdigest()==update['sha256']
try:read('/downloads/missing-mobile-more-polish.apk');raise AssertionError('missing APK served')
except urllib.error.HTTPError as error:assert error.code==404
deployment=json.loads((root/'deployment.json').read_text())
container=json.loads(subprocess.check_output(['docker','inspect',deployment['project']+'-web-1']))[0]
assert container['Image']==deployment['image']
assert any(m['Destination']=='/usr/share/nginx/html/downloads' and not m['RW'] for m in container['Mounts'])
proof={'trustedTLS':True,'mobile':200,'shellVersion':manifest['version'],'resources':len(manifest['files']),'readyz':200,'containerImageMatched':True,'apkDownloadsMountPreserved':True,'apkSizeAndSha256Verified':True,'missingApk':404}
(root/'checks.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps(proof))
