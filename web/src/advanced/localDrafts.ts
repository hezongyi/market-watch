/** One authenticated principal today; versioned records remain per tab/session.
 * Successful writes remove exactly their own draft version, never another tab's.
 */
export type PreferenceDraft = {
  key: string; version: string; kind: string; name: string; tool: string;
  value: unknown; base?: any; operation: 'save' | 'delete'; at?: number; storageKey?: string; failed?: boolean;
};
const prefix = 'mw-preference-draft:v1:admin:';
// A document gets a fresh writer ID. sessionStorage is deliberately not used:
// browsers clone it when opening/duplicating tabs. Persisted drafts are enumerated
// across writers for explicit recovery after reload or browser restart.
const writerId = crypto.randomUUID();
let restoredDrafts: Set<string> | undefined;
export function sessionId() { return writerId; }
export function preferenceDrafts() {
  const all: PreferenceDraft[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const storageKey = localStorage.key(i)!;
    if (!storageKey.startsWith(prefix)) continue;
    try {
      const draft = JSON.parse(localStorage.getItem(storageKey)!);
      if (draft && draft.version && draft.key && ['save','delete'].includes(draft.operation)) all.push({...draft, storageKey});
    } catch { /* Preserve unreadable records for manual recovery. */ }
  }
  return all.sort((a,b) => (b.at || 0) - (a.at || 0));
}
export function recoverablePreferenceDrafts() {
  const drafts = preferenceDrafts();
  // Capture unfinished versions on first render. New writes stay durable but
  // need no user action until the adapter reports their terminal failure.
  restoredDrafts ??= new Set(drafts.map(draft => JSON.stringify([draft.storageKey, draft.version])));
  return drafts.filter(draft => draft.failed || restoredDrafts!.has(JSON.stringify([draft.storageKey, draft.version])));
}
export function putPreferenceDraft(draft: PreferenceDraft) {
  if (!draft || typeof draft.key !== 'string' || draft.key.length > 500 || typeof draft.version !== 'string' ||
      !['save','delete'].includes(draft.operation) || JSON.stringify(draft).length > 1_100_000) throw Error('设置草稿无效或过大');
  const storageKey = prefix + sessionId() + ':' + encodeURIComponent(draft.key);
  localStorage.setItem(storageKey, JSON.stringify({...draft, failed: false, at: Date.now()}));
  return storageKey;
}
export function failPreferenceDraft(draft: Pick<PreferenceDraft,'key'|'version'|'storageKey'>) {
  const storageKey = draft.storageKey || prefix + sessionId() + ':' + encodeURIComponent(draft.key);
  if (!storageKey.startsWith(prefix)) throw Error('草稿作用域不匹配');
  const current = localStorage.getItem(storageKey);
  if (!current) return;
  const saved = JSON.parse(current);
  if (saved.version === draft.version) localStorage.setItem(storageKey, JSON.stringify({...saved, failed: true}));
}
export function dropPreferenceDraft(draft: Pick<PreferenceDraft,'key'|'version'|'storageKey'>) {
  const storageKey = draft.storageKey || prefix + sessionId() + ':' + encodeURIComponent(draft.key);
  if (!storageKey.startsWith(prefix)) throw Error('草稿作用域不匹配');
  const current = localStorage.getItem(storageKey);
  if (current && JSON.parse(current).version === draft.version) localStorage.removeItem(storageKey);
}
export function workspaceDraftKey(id: string) { return 'mw-tv-draft:v3:admin:' + sessionId() + ':' + id; }
export type WorkspaceDraft = {storageKey:string;raw:string;version:string;at:number;baseRevision?:number};
export function workspaceDraftEntries(id:string):WorkspaceDraft[] {
  const result:WorkspaceDraft[]=[];
  for(let i=0;i<localStorage.length;i++) {
    const storageKey=localStorage.key(i)!;
    if(storageKey !== 'mw-tv-draft:' + id && !(/^mw-tv-draft:v[23]:admin:/.test(storageKey) && storageKey.endsWith(':'+id)))continue;
    const stored=localStorage.getItem(storageKey)!;
    try {
      const value=JSON.parse(stored);
      if(value.draftVersion===3)result.push({storageKey,raw:JSON.stringify(value.document),version:value.version,at:value.at,baseRevision:value.baseRevision});
      else result.push({storageKey,raw:stored,version:stored,at:0});
    } catch { /* Never remove unreadable draft data. */ }
  }
  return result.sort((a,b)=>b.at-a.at || a.storageKey.localeCompare(b.storageKey));
}
export function workspaceDraft(id:string) {return workspaceDraftEntries(id)[0]?.raw || null;}
export function ownWorkspaceDraft(id:string) {return workspaceDraftEntries(id).find(row=>row.storageKey===workspaceDraftKey(id))?.raw || null;}
export function putWorkspaceDraft(id:string,raw:string,baseRevision?:number) {
  const storageKey=workspaceDraftKey(id),version=crypto.randomUUID(),at=Date.now();
  localStorage.setItem(storageKey,JSON.stringify({draftVersion:3,version,at,baseRevision,document:JSON.parse(raw)}));
  return {storageKey,raw,version,at,baseRevision};
}
export function dropWorkspaceDraft(draft:WorkspaceDraft) {
  const current=localStorage.getItem(draft.storageKey);
  if(!current)return;
  let version=current;try{const value=JSON.parse(current);if(value.draftVersion===3)version=value.version;}catch{return;}
  if(version===draft.version)localStorage.removeItem(draft.storageKey);
}
