import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  LockKeyhole,
  RefreshCw,
  Server,
  CircleAlert,
} from "lucide-react";
import { Button } from "./components/ui/button";
import { Spinner } from "./components/ui/spinner";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "./components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "./components/ui/input-group";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { MobileConfirm, MobileOverlaysProvider } from "./WatchOverlays";
import MobileSheet from "./MobileSheet";

export type LoginError = { message: string; password?: boolean };
export type LoginIntent = "discard" | "configure";

/** Authentication and cancellation stay owned by MobileApp; this surface owns presentation. */
export default function LoginPage({
  password,
  changePassword,
  busy,
  checking,
  error,
  intent,
  setIntent,
  submit,
  reconnect,
  configure,
}: {
  password: string;
  changePassword(value: string): void;
  busy: boolean;
  checking: boolean;
  error?: LoginError;
  intent?: LoginIntent;
  setIntent(value?: LoginIntent): void;
  submit(event: FormEvent<HTMLFormElement>): Promise<void>;
  reconnect(): void;
  configure(): Promise<void>;
}) {
  const [reveal, setReveal] = useState(false);
  const [serverHelp, setServerHelp] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const working = busy || checking || configuring;
  async function switchServer() {
    if (configuring) return;
    setConfiguring(true);
    setReveal(false);
    try {
      await configure();
      if (!window.MWMobileHost) setServerHelp(true);
    } finally {
      setConfiguring(false);
    }
  }
  return (
    <section className="mobile-login mobile-controls" aria-label="登录守望">
      <MobileOverlaysProvider>
        <div className="login-content">
          <header className="login-brand">
            <span className="login-brand-mark">
              <img src="/favicon.svg" alt="守望" />
            </span>
            <div>
              <h1>连接守望</h1>
              <p>你的个人行情工作区</p>
            </div>
          </header>
          <form className="login-form" onSubmit={submit} aria-busy={working}>
            <FieldGroup>
              <Field
                data-invalid={error?.password || undefined}
                data-disabled={working || undefined}
              >
                <FieldLabel htmlFor="mobile-password">密码</FieldLabel>
                <InputGroup className="login-password">
                  <InputGroupAddon>
                    <LockKeyhole aria-hidden="true" />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="mobile-password"
                    name="password"
                    type={reveal ? "text" : "password"}
                    autoComplete="current-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="go"
                    placeholder="输入登录密码"
                    required
                    value={password}
                    disabled={working}
                    aria-invalid={error?.password || undefined}
                    aria-describedby={
                      error?.password ? "login-password-error" : undefined
                    }
                    onChange={(event) => changePassword(event.target.value)}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-sm"
                      aria-label={reveal ? "隐藏密码" : "显示密码"}
                      aria-pressed={reveal}
                      disabled={working}
                      onClick={() => setReveal(!reveal)}
                    >
                      {reveal ? (
                        <EyeOff aria-hidden="true" />
                      ) : (
                        <Eye aria-hidden="true" />
                      )}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                {error?.password && (
                  <FieldError id="login-password-error">
                    {error.message}
                  </FieldError>
                )}
              </Field>
            </FieldGroup>
            {error && !error.password && (
              <Alert className="login-feedback" variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>暂时无法连接</AlertTitle>
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            )}
            <Button
              type="submit"
              className="login-submit primary"
              disabled={working}
            >
              {working ? (
                <Spinner data-icon="inline-start" aria-hidden="true" />
              ) : null}
              {configuring
                ? "正在切换…"
                : checking
                  ? "正在核验连接…"
                  : busy
                    ? "正在连接…"
                    : "登录"}
              {!working && (
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              )}
            </Button>
          </form>
          <div className="login-server" aria-label="当前服务器">
            <span className="login-server-icon">
              <Server aria-hidden="true" />
            </span>
            <div>
              <span>当前服务器</span>
              <p>{window.location.origin}</p>
            </div>
          </div>
          <div className="login-actions">
            <Button variant="ghost" disabled={working} onClick={reconnect}>
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              重新连接
            </Button>
            <Button
              variant="ghost"
              disabled={configuring}
              onClick={() => {
                if (password && !busy) setIntent("configure");
                else void switchServer();
              }}
            >
              换服务器
            </Button>
          </div>
        </div>
        <footer className="login-footer">行情 · 图表 · 提醒</footer>
        {intent && (
          <MobileConfirm
            title={intent === "configure" ? "更换服务器？" : "放弃密码输入？"}
            description={
              intent === "configure"
                ? "当前密码输入将清除，然后选择其他服务器。"
                : "密码尚未提交。你可以继续输入，或放弃本次输入。"
            }
            actionLabel={intent === "configure" ? "更换服务器" : "放弃输入"}
            cancelLabel="继续输入"
            onClose={() => setIntent(undefined)}
            onAccept={() => {
              setIntent(undefined);
              changePassword("");
              setReveal(false);
              if (intent === "configure") void switchServer();
            }}
          />
        )}
        <MobileSheet
          title="更换服务器"
          open={serverHelp}
          close={() => setServerHelp(false)}
        >
          <div className="login-server-help">
            <p>
              在浏览器中打开要连接的服务器 HTTPS 地址，并在地址末尾添加{" "}
              <code>/m/</code>。
            </p>
            <p>Android App 可在服务器设置中更换连接地址。</p>
            <Button onClick={() => setServerHelp(false)}>知道了</Button>
          </div>
        </MobileSheet>
      </MobileOverlaysProvider>
    </section>
  );
}
