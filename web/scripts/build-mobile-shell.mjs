// Run after native asset generation. Only mobile Vite resources enter the shell.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const dist = new URL("../dist/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL(".vite/manifest.json", dist)));
const resources = new Set(["/m/", "/favicon.svg"]);
const visited = new Set();
function visit(key) {
  if (visited.has(key)) return;
  visited.add(key);
  const entry = manifest[key];
  if (!entry) throw Error("Missing mobile build manifest entry: " + key);
  resources.add("/" + entry.file);
  for (const css of entry.css || []) resources.add("/" + css);
  for (const dependency of [
    ...(entry.imports || []),
    ...(entry.dynamicImports || []),
  ])
    visit(dependency);
}
visit("m/index.html");
const chart = readFileSync(new URL("chart-assets.json", dist));
const chartVersion = createHash("sha256")
  .update(chart)
  .digest("hex")
  .slice(0, 16);
const chartPath = `/m/chart-assets.${chartVersion}.json`;
mkdirSync(new URL("m/", dist), { recursive: true });
writeFileSync(new URL("." + chartPath, dist), chart);
resources.add(chartPath);
const htmlPath = new URL("m/index.html", dist);
const html = readFileSync(htmlPath, "utf8").replace(
  "</head>",
  `<meta name="mw-chart-manifest" content="${chartPath}"></head>`,
);
writeFileSync(htmlPath, html);
const files = [...resources].sort();
const hash = createHash("sha256").update(html);
for (const path of files)
  if (path !== "/m/") hash.update(readFileSync(new URL("." + path, dist)));
const version = hash.digest("hex").slice(0, 16);
const worker = `const CACHE='mw-mobile-shell-${version}';
const FILES=${JSON.stringify(files)};
const URLS=new Set(FILES.map(path=>new URL(path,self.location.origin).href));
self.addEventListener('install',event=>event.waitUntil((async()=>{
  try {const cache=await caches.open(CACHE);await cache.addAll(FILES);}
  catch(error){await caches.delete(CACHE);throw error;}
})()));
self.addEventListener('message',event=>{if(event.data?.type==='activate')self.skipWaiting();});
// Existing documents keep their controller until navigation. No clients.claim()
// or automatic reload can destroy an in-memory form or pending local write.
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const key of await caches.keys())if(key.startsWith('mw-mobile-shell-')&&key!==CACHE)await caches.delete(key);
})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  const navigation=request.mode==='navigate'&&url.pathname.startsWith('/m/');
  if(!navigation&&!URLS.has(url.href))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE),cached=await cache.match(navigation?'/m/':request);
    return cached||fetch(request);
  })());
});
`;
writeFileSync(new URL("m/sw.js", dist), worker);
writeFileSync(
  new URL("m/shell-manifest.json", dist),
  JSON.stringify({ version, files }, null, 2) + "\n",
);
console.log(
  `Mobile shell ${version}: ${files.length} public resources; native library excluded`,
);
