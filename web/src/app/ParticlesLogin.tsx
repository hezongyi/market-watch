import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  LockKeyhole,
  Moon,
  Pause,
  Play,
  ShieldCheck,
  Sun,
  Waves,
} from "lucide-react";
import { useApp } from "./context";
import { defaultChart, pageName } from "./navigation";
import "./app.css";

import { Particles } from "./Particles";

function readMotionPreference() {
  try {
    return localStorage.getItem("mw.login-motion") !== "off";
  } catch {
    return true;
  }
}

export default function ParticlesLogin({
  next,
  login,
  connectionError,
  retry,
}: {
  next: string;
  login: (password: string) => Promise<void>;
  connectionError?: string;
  retry: () => void;
}) {
  const { theme, setTheme } = useApp();
  const [password, setPassword] = useState(""),
    [shown, setShown] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [motion, setMotion] = useState(readMotionPreference),
    [reduced, setReduced] = useState(
      matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
  const input = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await login(password);
    } catch (e) {
      setError(String(e).replace(/^\w*Error: /, ""));
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }
  const deep = next !== defaultChart;
  return (
    <main className="auth-screen" data-theme={theme}>
      <Particles
        theme={theme}
        paused={!motion || reduced}
        quietAreaRef={card}
      />
      <header className="auth-header">
        <div className="auth-brand">
          <Waves aria-hidden="true" />
          <span>
            守望<small>MARKET WATCH</small>
          </span>
        </div>
        <div className="auth-actions">
          <span className="auth-caption">你的私人行情工作区</span>
          <button
            type="button"
            aria-label={
              reduced
                ? "系统已开启减少动态效果"
                : motion
                  ? "暂停背景动画"
                  : "开启背景动画"
            }
            disabled={reduced}
            title={reduced ? "系统已开启减少动态效果，显示静态背景" : undefined}
            aria-pressed={motion && !reduced}
            onClick={() => {
              setMotion(!motion);
              try {
                localStorage.setItem("mw.login-motion", motion ? "off" : "on");
              } catch {
                /* Animation remains controllable when storage is unavailable. */
              }
            }}
          >
            {motion && !reduced ? <Pause /> : <Play />}
          </button>
          <button
            type="button"
            aria-label={theme === "dark" ? "切换浅色主题" : "切换暗色主题"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </button>
        </div>
      </header>
      <div className="auth-stage">
        <section ref={card} className="auth-card" aria-labelledby="login-title">
          <div className="auth-card-caption">
            <LockKeyhole size={14} aria-hidden="true" /> 工作区登录
          </div>
          <h1 id="login-title">登录守望</h1>
          <p className="auth-description">
            {deep
              ? `登录后继续查看${pageName(next.split(/[?#]/)[0])}。`
              : "进入图表，管理警报与通知。"}
          </p>
          {connectionError && (
            <p role="alert" className="auth-connection">
              连接失败：{connectionError}
              <button type="button" onClick={retry}>
                重新连接
              </button>
            </p>
          )}
          <form onSubmit={submit}>
            <label htmlFor="admin-password">管理员密码</label>
            <div className="auth-password">
              <input
                ref={input}
                id="admin-password"
                name="password"
                type={shown ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                aria-invalid={!!error}
                aria-describedby="login-error"
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                aria-label={shown ? "隐藏密码" : "显示密码"}
                aria-pressed={shown}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const start = input.current?.selectionStart,
                    end = input.current?.selectionEnd;
                  setShown(!shown);
                  requestAnimationFrame(() => {
                    input.current?.focus();
                    input.current?.setSelectionRange(start ?? 0, end ?? 0);
                  });
                }}
              >
                {shown ? <EyeOff /> : <Eye />}
              </button>
            </div>
            <p
              id="login-error"
              className="auth-error"
              role={error ? "alert" : undefined}
            >
              {error}
            </p>
            <button
              className="auth-submit"
              disabled={busy || !!connectionError}
            >
              {busy ? "正在登录…" : deep ? "登录并继续" : "登录并进入图表"}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
            <small className="auth-privacy">
              <ShieldCheck size={14} aria-hidden="true" /> 单人账户 · 私有监控
            </small>
          </form>
        </section>
      </div>
      <footer className="auth-footnote">
        Market Watch · 专业图表与行情监控
      </footer>
    </main>
  );
}
