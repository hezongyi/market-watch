import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppContext } from "../app/context";
import { defaultChart } from "../app/navigation";
import ParticlesLogin from "../app/ParticlesLogin";
import "./preview.css";

function Preview() {
  const [theme, setTheme] = useState<"dark" | "light">(
    new URLSearchParams(location.search).get("theme") === "light"
      ? "light"
      : "dark",
  );
  return (
    <AppContext.Provider
      value={{
        theme,
        setTheme,
        pending: 0,
        registerGuard: () => () => {},
        confirmLeave: async () => true,
        logout: async () => {},
      }}
    >
      <ParticlesLogin
        next={defaultChart}
        retry={() => {}}
        login={async () => {
          // Visual confirmation gate: no authentication requests or fake success.
          throw new Error("当前为外观预览，确认后接入正式登录。");
        }}
      />
    </AppContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
