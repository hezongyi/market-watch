import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useId,
  Children,
  isValidElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
export type NativeControlFactory = (
  kind: "select" | "checkbox" | "button" | "menu" | "input" | "textarea",
  target: HTMLElement,
  props: Record<string, unknown>,
) => { update: (props: Record<string, unknown>) => void; destroy: () => void };
export const NativeControls = createContext<NativeControlFactory | null>(null);
export const NativeControlsDisabled = createContext(false);
export function NativeControl({
  kind,
  properties,
}: {
  kind: "select" | "checkbox" | "button" | "menu" | "input" | "textarea";
  properties: Record<string, unknown>;
}) {
  const factory = useContext(NativeControls)!,
    disabled = useContext(NativeControlsDisabled),
    target = useRef<HTMLSpanElement>(null),
    control = useRef<ReturnType<NativeControlFactory> | null>(null);
  useLayoutEffect(() => {
    control.current = factory(kind, target.current!, {
      ...properties,
      disabled: disabled || properties.disabled,
    });
    return () => {
      control.current?.destroy();
      control.current = null;
    };
  }, [factory, kind]);
  useLayoutEffect(() => {
    control.current?.update({
      ...properties,
      disabled: disabled || properties.disabled,
    });
  }, [properties, disabled]);
  return (
    <span
      ref={target}
      className={`mw-native-control mw-native-${kind}`}
      data-native-control={kind}
    />
  );
}
export function AlertInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const factory = useContext(NativeControls);
  if (!factory) return <input {...props} />;
  return (
    <NativeControl
      kind="input"
      properties={{
        ...props,
        size: "small",
        stretch: true,
        readonly: props.readOnly,
        reference: (node: HTMLInputElement | null) => {
          if (node) node.required = Boolean(props.required);
        },
      }}
    />
  );
}
export function AlertTextarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  const factory = useContext(NativeControls);
  return factory ? (
    <NativeControl
      kind="textarea"
      properties={{
        ...props,
        size: "small",
        stretch: true,
        resize: "vertical",
        readonly: props.readOnly,
      }}
    />
  ) : (
    <textarea {...props} />
  );
}
export function AlertSelect({
  children,
  onChange,
  value,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const factory = useContext(NativeControls),
    id = useId();
  if (!factory)
    return (
      <select {...props} value={value} onChange={onChange}>
        {children}
      </select>
    );
  const items = Children.toArray(children)
    .filter(isValidElement)
    .map((child) => {
      const p = child.props as {
        value?: string | number;
        children: ReactNode;
        disabled?: boolean;
      };
      return {
        value: String(p.value ?? p.children),
        content: Children.toArray(p.children).join(""),
        disabled: p.disabled,
      };
    });
  return (
    <NativeControl
      kind="select"
      properties={{
        id: props.id || id,
        value: String(value),
        items,
        disabled: props.disabled,
        stretch: true,
        size: "small",
        "aria-label": props["aria-label"],
        onChange: (next: string) =>
          onChange?.({
            target: { value: next },
            currentTarget: { value: next },
          } as any),
      }}
    />
  );
}
export function AlertCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const factory = useContext(NativeControls);
  return factory ? (
    <NativeControl
      kind="checkbox"
      properties={{
        label,
        checked,
        onChange: (event: any) => onChange(event.target.checked),
      }}
    />
  ) : (
    <label className="alert-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
export function AlertButton({
  children,
  disabled,
  onClick,
  primary = false,
}: {
  children: string;
  disabled?: boolean;
  onClick: () => void;
  primary?: boolean;
}) {
  const factory = useContext(NativeControls);
  return factory ? (
    <NativeControl
      kind="button"
      properties={{
        children,
        disabled,
        type: "button",
        size: "s",
        appearance: primary ? "default" : "stroke",
        intent: "default",
        onClick,
      }}
    />
  ) : (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}
