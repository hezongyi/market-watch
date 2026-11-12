import { useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  LockKeyhole,
  Moon,
  ShieldCheck,
  Sun,
  Waves,
} from "lucide-react";
import { useApp } from "./context";
import { defaultChart, pageName } from "./navigation";
import "./app.css";

export default function SimpleLogin({
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
  const input = useRef<HTMLInputElement>(null);
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
      <header className="auth-header">
        <div className="auth-brand">
          <Waves aria-hidden="true" />
          <span>
            守望<small>MARKET WATCH</small>
          </span>
        </div>
        <div className="auth-actions">
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
    </main>
  );
}
