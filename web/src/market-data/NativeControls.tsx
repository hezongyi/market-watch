import { Children, createContext, isValidElement, useContext, useLayoutEffect, useRef, useId, useState, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";

import { createPortal } from "react-dom";

export type NativeUi = {
  mount: (kind: string, node: HTMLElement, props: Record<string, any>) => { update: (props: Record<string, any>) => void; dispose: () => void };
  confirm: (options: {title:string;body:string}) => Promise<boolean>;
  pick: (options: Record<string, any>) => Promise<any | null>;
};
export const NativeUiContext = createContext<NativeUi | null>(null);
export function NativeOperationHint({children}: {children: string}) {
  const ui = useContext(NativeUiContext);
  return ui ? <NativeSlot kind="operationHint" props={{children}} className="dc-operation-hint" /> : <footer className="dc-operation-hint">{children}</footer>;
}
export function NativeSlot({ kind, props, className = "" }: { kind: string; props: Record<string, any>; className?: string }) {
  const ui = useContext(NativeUiContext), node = useRef<HTMLDivElement>(null);
  const instance = useRef<ReturnType<NativeUi["mount"]> | null>(null);
  const latest = useRef(props); latest.current = props;
  useLayoutEffect(() => {
    if (!ui || !node.current) return;
    const fieldsets: HTMLFieldSetElement[] = [];
    for (let parent = node.current.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLFieldSetElement) fieldsets.push(parent);
    const adapted=()=>({...latest.current,disabled:latest.current.disabled || fieldsets.some(fieldset=>fieldset.disabled)});
    instance.current = ui.mount(kind, node.current, adapted());
    const observer=new MutationObserver(()=>instance.current?.update(adapted()));
    for (const fieldset of fieldsets) observer.observe(fieldset,{attributes:true,attributeFilter:["disabled"]});
    return () => { observer.disconnect();instance.current?.dispose(); instance.current = null; };
  }, [ui, kind]);
  useLayoutEffect(() => { instance.current?.update({...props,disabled:props.disabled || !!node.current?.closest("fieldset[disabled]")}); });
  return <div className={`dc-native-slot ${className}`} ref={node} />;
}

// Keep native form semantics on the actual input: vendor InputControl uses
// ariaRequired but does not forward required/list/number validity attributes.
export function NativeInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const ui = useContext(NativeUiContext), generated = useId(), input = useRef<HTMLInputElement | null>(null);
  const id=props.id || `dc-input-${generated.replace(/[^a-zA-Z0-9-]/g, "")}`;
  useLayoutEffect(() => {
    const node=input.current;
    if(!node) return;
    node.required=!!props.required;
    node.readOnly=!!props.readOnly;
    for(const name of ["list","minLength"] as const) {
      const value=props[name];
      if(value!==undefined) node.setAttribute(name,String(value)); else node.removeAttribute(name);
    }
    let label=node.closest("label");
    while(label && !props["aria-label"]) {
      const text=[...label.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join(" ").trim();
      if(text) {node.setAttribute("aria-label",text);break;}
      label=label.parentElement?.closest("label") || null;
    }
  });
  if (!ui || ["date", "datetime-local", "radio", "hidden", "file"].includes(props.type || "")) return <input {...props} />;
  const kind = props.type === "checkbox" ? "checkbox" : props.type === "search" ? "search" : "input";
  const mapped = { ...props, id, size: "small", ...(kind === "input" ? { stretch: true } : {}), readonly: props.readOnly,
    reference: (node:HTMLInputElement|null)=>{input.current=node;if(node) {node.required=!!props.required;node.readOnly=!!props.readOnly;}}, ariaInvalid: props["aria-invalid"], ariaDescribedby: props["aria-describedby"], ariaRequired: props.required };
  return <NativeSlot kind={kind} props={mapped} className={kind === "checkbox" ? "dc-native-check" : ""} />;
}

function options(children: ReactNode): { value: string; content: ReactNode; disabled?: boolean }[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ value?: string; children?: ReactNode; disabled?: boolean }>(child)) return [];
    if (child.type === "option") return [{ value: String(child.props.value ?? child.props.children ?? ""), content: child.props.children, disabled: child.props.disabled }];
    return options(child.props.children);
  });
}
export function NativeSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const ui = useContext(NativeUiContext), generated = useId(), outer=useRef<HTMLDivElement>(null);
  const trigger=useRef<HTMLButtonElement|null>(null);
  const [label,setLabel]=useState(props["aria-label"] || "");
  const [invalid,setInvalid]=useState(false);
  const id = props.id || `dc-select-${generated.replace(/[^a-zA-Z0-9-]/g, "")}`;
  useLayoutEffect(()=>{
    const doc=outer.current?.ownerDocument;
    const node=outer.current?.closest("label") || doc?.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    if(!node) return;
    if(!props["aria-label"]) setLabel([...node.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join(" ").trim());
    // Explicitly associate the label with the native button, so the required
    // proxy select can never become the label's default activation target.
    const previous=node.getAttribute("for");
    node.htmlFor=id;
    return()=>{if(previous===null) node.removeAttribute("for");else node.setAttribute("for",previous);};
  },[ui,props["aria-label"],id]);
  useLayoutEffect(()=>{if(props.value || props.disabled) setInvalid(false);},[props.value,props.disabled]);
  if (!ui) return <select {...props} />;
  const items = options(props.children);
  const value = String(props.value ?? props.defaultValue ?? items[0]?.value ?? "");
  const change = (next: string) => {
    setInvalid(false);
    props.onChange?.({ target: { value: next }, currentTarget: { value: next } } as any);
  };
  const describedby=[props["aria-describedby"],invalid ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return <div ref={outer} className="dc-select-control">
    <NativeSlot kind="select" props={{ id, value, items, onChange: change, disabled: props.disabled,
      reference:(node:HTMLButtonElement|null)=>{trigger.current=node;},
      "aria-label": props["aria-label"] || label, "aria-labelledby": props["aria-labelledby"], "aria-describedby": describedby,
      "aria-invalid": invalid || props["aria-invalid"], size: "small", className: "dc-native-select" }} />
    {props.required && <select className="dc-validity" aria-hidden="true" tabIndex={-1} required value={value} disabled={props.disabled}
      name={props.name} form={props.form} onChange={props.onChange} onInvalid={event=>{
        event.preventDefault();setInvalid(true);
        const form=event.currentTarget.form;
        // Validation dispatches invalid to every field. Keep focus on the first.
        if(!form || form.querySelector("input:invalid,select:invalid,textarea:invalid") === event.currentTarget) {
          const field=event.currentTarget;
          // The browser focuses the first non-cancelled ordinary input after
          // dispatching every invalid event. Restore our visible first field
          // after that validation step, rather than letting a later input win.
          requestAnimationFrame(()=>{if(field.isConnected && field.matches(":invalid")) trigger.current?.focus();});
        }
        props.onInvalid?.(event);
      }}>{props.children}</select>}
    {invalid && <small id={`${id}-error`} className="dc-field-error" role="alert">请选择{props["aria-label"] || label || "必填选项"}</small>}
  </div>;
}

export function NativeSidebar({children}:{children:ReactNode}) {
  const [node,setNode]=useState<HTMLElement|null>(null);
  return <><NativeSlot kind="sidebar" props={{className:"dc-native-sidebar",contentRef:setNode}} />{node && createPortal(children,node)}</>;
}

export function NativeButton({ primary = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  const ui = useContext(NativeUiContext);
  if (!ui) return <button {...props} type={props.type || "button"} className={`${props.className || ""}${primary ? " primary" : ""}`} />;
  return <NativeSlot kind="button" props={{ ...props, type: props.type || "button", size: "s",
    appearance: primary ? "default" : "stroke", intent: "default" }} />;
}

export function NativeTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ui = useContext(NativeUiContext), generated = useId();
  const id = props.id || `dc-textarea-${generated.replace(/[^a-zA-Z0-9-]/g, "")}`;
  if (!ui) return <textarea {...props} />;
  const { "aria-label": labelText, ...nativeProps } = props;
  return <NativeSlot kind="textarea" props={{ ...nativeProps, id, size: "small", stretch: true,
    style: { height: "auto", minHeight: `${(props.rows || 3) * 24}px`, ...props.style },
    resize: "vertical", readonly: props.readOnly, ref: (node: HTMLTextAreaElement | null) => {
      if (!node) return;
      // This native component forwards the accessible label to its shell.
      // Keep the actual editable field named, including after async mounting.
      const label = node.closest("label");
      const title = labelText || (label && [...label.childNodes]
        .filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join(" ").trim());
      if (title) node.setAttribute("aria-label", title);
    } }} />;
}
