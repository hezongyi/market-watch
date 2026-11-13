import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    MWMobileHost?: {
      postMessage(value: string): void;
      onmessage?: (event: { data: string }) => void;
    };
  }
}
const protocol = 1;
function host(action: string, fields?: { theme: "light" | "dark" }) {
  window.MWMobileHost?.postMessage(
    JSON.stringify({ version: protocol, action, ...fields }),
  );
}
export function useMobileShell(
  flush: () => Promise<void>,
  hasInput: () => boolean,
  theme: "light" | "dark",
) {
  const [info, setInfo] = useState<{
    appVersion?: string;
    webViewVersion?: string;
    capabilities?: string[];
  }>();
  const [appUpdate, setAppUpdate] = useState<{
    status: string;
    label: string;
  }>();
  const [update, setUpdate] = useState(false),
    registration = useRef<ServiceWorkerRegistration | undefined>(undefined);
  const activated = useRef(false);
  const latest = useRef({ flush, hasInput });
  latest.current = { flush, hasInput };
  useEffect(() => {
    if (window.MWMobileHost) {
      window.MWMobileHost.onmessage = (event) => {
        const result = JSON.parse(event.data);
        if (result.version !== protocol || result.error)
          alert(result.error || "请更新 APK：页面协议不兼容");
        else if (result.appUpdate) setAppUpdate(result.appUpdate);
        else setInfo(result);
      };
      host("hello");
    }
    if (!("serviceWorker" in navigator) || !isSecureContext) return;
    let active = true;
    const reload = () => {
      if (!active) return;
      activated.current = true;
      setUpdate(true);
      if (latest.current.hasInput()) return;
      void latest.current
        .flush()
        .then(() => {
          if (active && !latest.current.hasInput()) window.location.reload();
        })
        .catch(() => {});
    };
    navigator.serviceWorker.addEventListener("controllerchange", reload);
    void navigator.serviceWorker
      .register("/m/sw.js", { scope: "/m/", updateViaCache: "none" })
      .then((value) => {
        if (!active) return;
        registration.current = value;
        if (value.waiting) setUpdate(true);
        value.addEventListener("updatefound", () => {
          const installing = value.installing;
          installing?.addEventListener("statechange", () => {
            if (
              active &&
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            )
              setUpdate(true);
          });
        });
      })
      .catch(() => {
        /* Online viewing remains available; offline installation is unconfirmed. */
      });
    return () => {
      active = false;
      navigator.serviceWorker.removeEventListener("controllerchange", reload);
    };
  }, []);
  useEffect(() => {
    if (info?.capabilities?.includes("appearance-v1")) host("appearance", { theme });
  }, [theme, info]);
  return {
    update,
    info,
    appUpdate,
    checkUpdates: async () => {
      if (latest.current.hasInput())
        throw Error("请先完成或放弃当前输入，再检查更新");
      await latest.current.flush();
      if (latest.current.hasInput())
        throw Error("请先完成或放弃当前输入，再检查更新");
      // A webpage update is independent from the native installation package.
      await registration.current?.update();
      if (info?.capabilities?.includes("app-update-v1")) {
        setAppUpdate({ status: "checking", label: "正在检查更新…" });
        host("check-app-update");
      } else {
        setAppUpdate({
          status: "unsupported",
          label: window.MWMobileHost
            ? "当前 APK 尚不支持应用内更新，请先覆盖安装 0.1.2。之后可在这里更新。"
            : "已检查网页更新；APK 更新请在 Android App 中使用。",
        });
      }
    },
    apply: async () => {
      if (latest.current.hasInput())
        throw Error("请先完成或放弃当前输入，再更新页面");
      await latest.current.flush();
      if (latest.current.hasInput())
        throw Error("请先完成或放弃当前输入，再更新页面");
      if (activated.current) window.location.reload();
      else registration.current?.waiting?.postMessage({ type: "activate" });
    },
    configure: () => {
      if (window.MWMobileHost) host("configure");
      else alert("请在浏览器打开新的可信 HTTPS 服务器地址 /m/。");
    },
    clearCookies: () => host("clear-session"),
    exit: () => host("exit"),
  };
}
