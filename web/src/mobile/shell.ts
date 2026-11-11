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
function host(action: string) {
  window.MWMobileHost?.postMessage(
    JSON.stringify({ version: protocol, action }),
  );
}
export function useMobileShell(
  flush: () => Promise<void>,
  hasInput: () => boolean,
) {
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
  return {
    update,
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
