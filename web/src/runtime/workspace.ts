/** Saved layout operations own draft preservation and stale-result rejection. */
import {putWorkspaceDraft,dropWorkspaceDraft,workspaceDraft} from '../advanced/localDrafts';
import type {api as requestAPI} from '../api';
import type {Dispatch,SetStateAction} from 'react';
import type {useNotices} from '../notifications/context';
import type {ChartUpdate} from './chart';
export type Workspace={id:string;name:string;revision:number;document:Record<string,any>;initial_symbol?:{ticker:string;metadata:Record<string,unknown>}};
type Ref<T>={current:T};
type Options={
 api:typeof requestAPI;mobile:boolean;queue:Ref<Promise<void>>;blocked:Ref<boolean>;current:Ref<Workspace|null>;unsaved:Ref<boolean>;alertUiSession:Ref<string>;
 setError:(value:string)=>void;setFeedError:(value:string)=>void;setStatus:(value:string)=>void;setActive:(value:Workspace|null)=>void;
 setRows:Dispatch<SetStateAction<Workspace[]>>;notices:ReturnType<typeof useNotices>;select:(row:Workspace)=>void;remember:(id:string)=>void;
 readAlertDraft:(id:string)=>any;refresh:()=>Promise<Workspace[]>;updateChart:(value:ChartUpdate)=>void;
};
export function workspaceRuntime({api,mobile,queue,blocked,current,setError,notices,select,setFeedError,setStatus,setActive,remember,alertUiSession,readAlertDraft,setRows,refresh,unsaved,updateChart}:Options){
return async (q:any,valid:()=>boolean)=>{
        if (
          !q ||
          !["list", "load", "save", "delete"].includes(q.op) ||
          JSON.stringify(q).length > 4_100_000 ||
          (mobile && ["save", "delete"].includes(q.op))
        ) {
          throw Error("工作区操作不允许");
        }
        if (
          ["load", "delete"].includes(q.op) &&
          !/^[a-zA-Z0-9-]{1,40}$/.test(q.args?.id || "")
        ) {
          throw Error("无效工作区标识");
        }
        try {
          await queue.current;
          if(!valid())throw Error("工作区已切换");
          if (
            blocked.current &&
            (q.op === "load" || (q.op === "save" && q.args?.id))
          )
            throw Error("存在未保存草稿，请先复制恢复为独立工作区");
          const draftId = q.op === "save" ? q.args?.id : null;
          const draft = draftId
            ? JSON.stringify({
                ...(current.current?.id === draftId
                  ? current.current?.document
                  : {}),
                engine: "tv31",
                schemaVersion: 1,
                state: JSON.parse(q.args.content),
                symbol: q.args.symbol,
                interval: q.args.resolution,
              })
            : null;
          let savedDraft: ReturnType<typeof putWorkspaceDraft> | undefined;
          if (draftId && draft) {
            try {
              savedDraft = putWorkspaceDraft(draftId, draft, current.current?.revision);
            } catch {
              setError("本地草稿空间不足，请勿关闭页面，等待服务器保存完成");
              void notices.report({source_kind:'workspace',attempt_id:crypto.randomUUID(),code:'LOCAL_DRAFT_FAILED',title:'图表草稿未能保存到本机',message:'本机存储写入失败，请勿关闭页面',context:{workspace_id:draftId}});
            }
          }
          let result;
          if (q.op === "list")
            result = await api("/advanced-charts/native-charts");
          else if (q.op === "load")
            result = await api("/advanced-charts/native-charts/" + q.args.id);
          else if (q.op === "save")
            result = await api("/advanced-charts/native-charts/save", q.args);
          else
            result = await api(
              "/advanced-charts/workspaces/" + q.args.id + "/delete",
              { revision: q.args.revision },
            );
          if(!valid())throw Error("工作区已切换，忽略过期响应");
          if (
            q.op === "load" &&
            (!result.document?.state ||
              Object.keys(result.document.state).length === 0)
          ) {
            // A never-saved workspace has no vendor layout envelope. Initialize
            // a fresh widget instead of loading {} or copying the current chart.
            select({
              id: result.id,
              name: result.name,
              revision: result.revision,
              document: result.document,
            });
            setFeedError("");
            throw Error("正在初始化空工作区");
          }
          if (q.op === "save" || q.op === "load") {
            // A successful native Save As binds a new independent workspace.
            // Keep any older failed draft available under its original ID.
            if (q.op === "save" && !q.args?.id) {
              blocked.current = false;
              setError("");
              setFeedError("");
              setStatus("已另存为独立工作区");
            }
            if (savedDraft) dropWorkspaceDraft(savedDraft);
            const previousWorkspace = current.current?.id;
            current.current = {
              id: result.id,
              name: result.name,
              revision: result.revision,
              document: result.document,
            };
            // Native loads happen inside the existing widget. Reflect their
            // identity without recreating the iframe or discarding chart state.
            setActive(current.current);
            remember(result.id);
            if (previousWorkspace !== result.id || q.op === "load") {
              alertUiSession.current = crypto.randomUUID();
              updateChart({
                type: "chart-alert-ui-scope",
                workspace_id: result.id,
                session: alertUiSession.current,
                draft: readAlertDraft(result.id),
              });
            }
            setRows((p) =>
              p.some((x) => x.id === result.id)
                ? p.map((x) => (x.id === result.id ? current.current! : x))
                : [current.current!, ...p],
            );
          }
          if (q.op === "delete")
            setRows((previous) =>
              previous.filter((row) => row.id !== q.args.id),
            );
          if (q.op === "delete" && current.current?.id === q.args.id) {
            // Do not leave a widget bound to a record which no longer exists.
            // Deletion is already committed; a refresh failure must not revive it.
            current.current = null;
            unsaved.current = false;
            blocked.current = false;
            setActive(null);
            setError("");
            setStatus("工作区已删除");
            try {
              const remaining = await refresh();
              if (remaining[0]) select(remaining[0]);
              return result;
        } catch (e) {
          if(!valid())throw e;
              setError("工作区已删除，列表加载失败：" + String(e));
            }
          }
          return result;
        } catch (e) {
          if(!valid())throw e;
          if (
            q.op === "save" &&
            q.args?.id &&
            workspaceDraft(q.args.id)
          ) {
            blocked.current = true;
            setStatus("保存已暂停 · 草稿已保留，请复制恢复");
          }
          setError(String(e));
          throw e;
        }

};
}
