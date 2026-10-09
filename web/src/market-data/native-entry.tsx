import { createRoot } from "react-dom/client";
import DataCenterWindow, { type HostedCenter } from "./Window";
import { NativeUiContext, type NativeUi } from "./NativeControls";
import { setCenterTransport } from "./api";
import { ApiError } from "../api";
import "./content.css";

type MountOptions = HostedCenter & { ui: NativeUi; request: (path: string, body?: unknown, signal?: AbortSignal) => Promise<any> };
declare global { interface Window { MWNativeCenter: { mount: (node: HTMLElement, options: MountOptions) => { dispose: () => void } } } }
window.MWNativeCenter = {
  mount(node, options) {
    setCenterTransport(async <T,>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
      try { return await options.request(path, body, signal); }
      catch (error: any) {
        if (error.status) throw new ApiError(error.message, error.status, error.code);
        throw error;
      }
    });
    const root = createRoot(node);
    root.render(<NativeUiContext value={options.ui}><DataCenterWindow hosted={options} /></NativeUiContext>);
    return { dispose() { root.unmount(); setCenterTransport(null); } };
  },
};
