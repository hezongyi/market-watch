import "../notifications/native";
import type { NoticeState, NoticeTransport } from "../notifications/types";
import type { OverlayBounds } from "../notifications/NativeSystemMessages";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ChartAlertsPanel, type AlertDraft } from "./ChartAlertsPanel";
import { rpcError } from "../api";
import type { AlertApi, AlertUiScope } from "./chartAlertUiApi";
import type { AlertContext } from "./chartAlerts";
import {
  NativeControls,
  type NativeControlFactory,
} from "./NativeAlertControls";

export type NativeAlertDialogHandle = {
  shell: HTMLElement;
  body: HTMLElement;
  busy: boolean;
  onEscape: (() => void) | null;
  close: () => void;
  setBusy: (busy: boolean) => void;
  setTitle: (title: string, symbol?: string) => void;
  recenter: () => void;
};
export type NativeAlertDialog = (options: {
  title: string;
  symbol?: string;
  onClose: () => void;
}) => Promise<NativeAlertDialogHandle>;
type Shell = {
  isOpen?: () => boolean;
  open: () => void;
  close: () => void;
  destroy: () => void;
  openDialog: NativeAlertDialog;
  setBadge?: (count?: number) => void;
  control: NativeControlFactory;
  overlayBounds: (anchor?: HTMLElement) => OverlayBounds;
};
declare global {
  var nativeAlertShell: (
    widget: unknown,
    callbacks: {
      mount: (node: HTMLElement) => void;
      unmount: (node: HTMLElement) => void;
      report: (error: unknown) => void;
      page?: string | null;
      title?: string;
      icon?: string;
    },
  ) => Promise<Shell>;
  var MWNativeAlerts: { attach: typeof attach };
}
type Options = {
  widget: unknown;
  scope: AlertUiScope;
  readonly: boolean;
  request: (query: object) => Promise<any>;
  bridge: {
    create: () => unknown;
    creationReason?: () => string;
    setRows: (rows: any) => void;
    locate: (row: any, event?: any) => void;
    drawingAction: (id: string, action: string) => void;
    currentInstrument: () => { instrument: string; series_kind: string } | null;
  };
  report: (error: unknown) => void;
  initialDraft?: AlertDraft | null;
  persistDraft?: (draft: AlertDraft | null) => void;
  noticeRequest?: NoticeTransport;
  noticeState?: NoticeState;
  panelChanged?: (open: boolean, signalId?: string) => void;
};
async function attach({
  widget,
  scope,
  readonly,
  request,
  bridge,
  report,
  initialDraft,
  persistDraft,
  panelChanged,
  noticeRequest,
  noticeState,
}: Options) {
  let target: HTMLElement | null = null,
    disposed = false;
  const pendingState: Partial<State> = {};
  let update: (patch: Partial<State>) => void = (patch) =>
    Object.assign(pendingState, patch);
  const shell = await globalThis.nativeAlertShell(widget, {
    mount: (node) => {
      target = node;
      update({ target: node });
    },
    unmount: (node) => {
      if (target === node) {
        target = null;
        update({ target: null });
      }
    },
    report,
  });
  // React business state remains in this host document. Native pages are portals;
  // changing or rebuilding their containers never creates a second poller/draft.
  const host = document.createElement("div");
  host.dataset.name = "mw-alert-state";
  document.body.appendChild(host);
  const root = createRoot(host);
  const call: AlertApi = async (path, body) => {
    if (disposed) throw Error("告警图表已销毁");
    try {
      return await request({
        ...scope,
        path,
        ...(body === undefined ? {} : { body }),
      });
    } catch (error: any) {
      throw rpcError(error);
    }
  };
  type State = {
    target: HTMLElement | null;
    context: AlertContext | null;
    focusEvent?: { id: string; revision: number };
    theme: string;
    alertUnread?: number;
    creationReason: string;
    notices: Record<string, string>;
    instrument: { instrument: string; series_kind: string } | null;
  };
  function App() {
    const [state, setState] = useState<State>({
      target,
      alertUnread: noticeState?.alertUnread,
      context: null,
      theme: "dark",
      creationReason: bridge.creationReason?.() || "",
      notices: {},
      instrument: bridge.currentInstrument(),
      ...pendingState,
    });
    update = (patch) => {
      if (!disposed) setState((previous) => ({ ...previous, ...patch }));
    };
    return (
      <NativeControls.Provider value={shell.control}>
        <ChartAlertsPanel
          workspaceId={scope.workspace_id}
          context={state.context}
          focusEvent={state.focusEvent}
          noticeRequest={noticeRequest}
          alertUnread={state.alertUnread}
          open
          theme={state.theme}
          readonly={readonly}
          creationUnavailable={state.creationReason}
          request={call}
          activeInstrument={state.instrument}
          nativeDialog={shell.openDialog}
          mountTarget={state.target}
          initialDraft={initialDraft}
          persistDraft={persistDraft}
          associationNotices={state.notices}
          onClose={shell.close}
          onRequest={() => bridge.create()}
          onRows={(rows) => bridge.setRows(rows)}
          onLocate={(row, event) => bridge.locate(row, event)}
          onDrawingAction={(row, action) =>
            bridge.drawingAction(row.id, action)
          }
        />
      </NativeControls.Provider>
    );
  }
  root.render(<App />);
  let notices: Record<string, string> = {};
  let lastInstrument = "", lastReason = "";
  let lastPanel: boolean | undefined;
  const timer = setInterval(() => {
    const opened = shell.isOpen?.();
    if (opened !== undefined && opened !== lastPanel) {
      lastPanel = opened;
      panelChanged?.(opened);
    }
    const reason = bridge.creationReason?.() || "";
    if (reason !== lastReason) {lastReason=reason; update({creationReason:reason});}
    const instrument = bridge.currentInstrument(),
      identity = JSON.stringify(instrument);
    if (identity !== lastInstrument) {
      lastInstrument = identity;
      update({ instrument });
    }
  }, 250);
  return {
    open: shell.open,
    noticeState: (state: NoticeState) => {update({alertUnread: state.alertUnread}); shell.setBadge?.(state.alertUnread);},
    event: (id: string) => {
      update({ focusEvent: { id, revision: Date.now() } });
      shell.open();
      panelChanged?.(true, id);
    },
    context: (context: AlertContext) => {
      if (context.association.workspace_id === scope.workspace_id) {
        update({ context });
        shell.open();
      }
    },
    theme: (theme: string) => update({ theme: theme.toLowerCase() }),
    association: (id: string, text: string) => {
      notices = { ...notices, [id]: text };
      update({ notices });
    },
    destroy: () => {
      disposed = true;
      clearInterval(timer);
      root.unmount();
      shell.destroy();
      host.remove();
    },
  };
}
globalThis.MWNativeAlerts = { attach };
