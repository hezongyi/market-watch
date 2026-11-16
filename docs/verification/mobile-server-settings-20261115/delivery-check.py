"""Check the Ubuntu acceptance APK over the CA trusted by the debug shell."""
import hashlib
import json
from pathlib import Path
import ssl
import subprocess
import urllib.error
import urllib.request

folder = Path(__file__).resolve().parent
repo = folder.parents[2]
base = 'https://192.168.7.232:18447'
context = ssl.create_default_context(cafile=str(repo / 'mobile/client/app/src/debug/res/raw/android_personal_dev_ca.pem'))
client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))

def read(route):
    with client.open(base + route, timeout=30) as response:
        assert response.status == 200
        return response.read(), response.headers

read('/readyz')
read('/m/')
content, headers = read('/downloads/android-update.json')
assert 'no-store' in headers.get('cache-control', '')
update = json.loads(content)
assert update['versionCode'] == 5 and update['versionName'] == '0.1.4'
assert update['applicationId'] == 'com.kookvv.marketwatch'
apk, _ = read('/downloads/' + update['apk'])
assert len(apk) == update['size']
assert hashlib.sha256(apk).hexdigest() == update['sha256']
assert apk == (repo / 'mobile/client/app/build/outputs/apk/debug/app-debug.apk').read_bytes()
try:
    read('/downloads/missing-server-settings.apk')
    raise AssertionError('missing APK served')
except urllib.error.HTTPError as error:
    assert error.code == 404
container = json.loads(subprocess.check_output(['docker', 'inspect', 'mw-managed-live-rollover-20261113-web-1']))[0]
assert any(m['Destination'] == '/usr/share/nginx/html/downloads' and not m['RW'] for m in container['Mounts'])
proof = {'host': 'Ubuntu local Docker', 'base': base, 'versionCode': 5, 'versionName': '0.1.4',
         'apk': update['apk'], 'size': len(apk), 'sha256': update['sha256'],
         'trustedTLS': True, 'manifestNoStore': True, 'downloadEqualsBuiltApk': True,
         'missingApk': 404, 'webImageUnchanged': container['Image'], 'readonlyDownloadMount': True}
(folder / 'delivery.json').write_text(json.dumps(proof, indent=2) + '\n')
print(json.dumps(proof))
