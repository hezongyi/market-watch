import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type CSSProperties,
} from "react";
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

// Adapted from Magic UI Dot Pattern (MIT); see MAGIC_UI_LICENSE.md.
function DotBackground({ paused }: { paused: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const spacing = size.width <= 760 ? 28 : 32;
  const cols = Math.ceil(size.width / spacing),
    rows = Math.ceil(size.height / spacing);
  const count = Math.min(64, Math.floor((size.width * size.height) / 24000));
  const dots = Array.from({ length: count }, (_, i) => ({
    x: ((i * 37 + 11) % Math.max(cols, 1)) * spacing + spacing / 2,
    y: ((i * 23 + 7) % Math.max(rows, 1)) * spacing + spacing / 2,
  }));
  return (
    <div
      ref={host}
      className="dot-background"
      aria-hidden="true"
      data-paused={paused}
    >
      <svg width="100%" height="100%">
        <defs>
          <pattern
            id="login-dot-grid"
            width={spacing}
            height={spacing}
            patternUnits="userSpaceOnUse"
          >
            <circle
              className="dot-base"
              cx={spacing / 2}
              cy={spacing / 2}
              r="1"
            />
          </pattern>
          <radialGradient id="login-dot-glow">
            <stop className="dot-halo" offset="0" stopOpacity=".6" />
            <stop className="dot-halo" offset="1" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#login-dot-grid)" />
        {dots.map((p, i) => (
          <g key={i} transform={`translate(${p.x} ${p.y})`}>
            <g
              className="dot-pulse"
              style={
                {
                  "--breath-duration": `${7 + (i % 6)}s`,
                  "--breath-delay": `${-i * 0.71}s`,
                } as CSSProperties
              }
            >
              <circle r="5" fill="url(#login-dot-glow)" />
              <circle className="dot-core" r="1.15" />
            </g>
          </g>
        ))}
      </svg>
    </div>
  );
}
export default function Login({
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
  const [motion, setMotion] = useState(
      localStorage.getItem("mw.login-motion") !== "off",
    ),
    [focused, setFocused] = useState(false),
    [hidden, setHidden] = useState(document.hidden);
  const [reduced, setReduced] = useState(
    matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const visibility = () => setHidden(document.hidden),
      media = matchMedia("(prefers-reduced-motion: reduce)"),
      change = () => setReduced(media.matches);
    document.addEventListener("visibilitychange", visibility);
    media.addEventListener("change", change);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      media.removeEventListener("change", change);
    };
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
      <DotBackground paused={!motion || focused || busy || hidden || reduced} />
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
            aria-label={motion ? "暂停背景动画" : "开启背景动画"}
            aria-pressed={motion}
            onClick={() => {
              setMotion(!motion);
              localStorage.setItem("mw.login-motion", motion ? "off" : "on");
            }}
          >
            {motion ? <Pause /> : <Play />}
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
        <section className="auth-card" aria-labelledby="login-title">
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
          <form
            onSubmit={submit}
            onFocus={() => setFocused(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node))
                setFocused(false);
            }}
          >
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
