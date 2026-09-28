#!/usr/bin/env python3
"""Build a dependency-free Android companion with official Android SDK build tools.
Set ANDROID_PLATFORM_JAR and ANDROID_BUILD_TOOLS to installed official SDK paths.
This creates a local development signing key on first build; retain it for upgrades.
"""
import os,subprocess,zipfile
from pathlib import Path
root=Path(__file__).resolve().parent
out=root.parent/'artifacts'/'android';out.mkdir(parents=True,exist_ok=True)
platform=Path(os.environ['ANDROID_PLATFORM_JAR']);tools=Path(os.environ['ANDROID_BUILD_TOOLS'])
classes=out/'classes';classes.mkdir(exist_ok=True)
def run(*args):subprocess.run([str(a) for a in args],check=True)
run('javac','-source','17','-target','17','-encoding','UTF-8','-classpath',platform,'-d',classes,*sorted((root/'src').rglob('*.java')))
run('jar','cf',out/'classes.jar','-C',classes,'.')
run(tools/'d8','--lib',platform,'--min-api','26','--output',out,out/'classes.jar')
run(tools/'aapt2','link','-I',platform,'--manifest',root/'AndroidManifest.xml','-o',out/'unsigned.apk','--min-sdk-version','26','--target-sdk-version','35')
with zipfile.ZipFile(out/'unsigned.apk','a') as z:z.write(out/'classes.dex','classes.dex')
run(tools/'zipalign','-f','4',out/'unsigned.apk',out/'aligned.apk')
key=out/'development.keystore'
if not key.exists():
 run('keytool','-genkeypair','-keystore',key,'-storepass','android','-keypass','android','-alias','development','-keyalg','RSA','-keysize','2048','-validity','10000','-dname','CN=Market Watch Development')
 key.chmod(0o600)
run(tools/'apksigner','sign','--ks',key,'--ks-pass','pass:android','--key-pass','pass:android','--out',out/'market-watch-reminder.apk',out/'aligned.apk')
run(tools/'apksigner','verify','--verbose',out/'market-watch-reminder.apk')
print(out/'market-watch-reminder.apk')
