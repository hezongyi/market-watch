import { Children, createContext, isValidElement, useContext, useLayoutEffect, useRef, useId, useState, type InputHTMLAttributes, type SelectHTMLAttributes, type ReactNode } from "react";

import { createPortal } from "react-dom";

export type NativeUi = {
  mount: (kind: string, node: HTMLElement, props: Record<string, any>) => { update: (props: Record<string, any>) => void; dispose: () => void };
  confirm: (options: {title:string;body:string}) => Promise<boolean>;
  pick: (options: Record<string, any>) => Promise<any | null>;
};
export const NativeUiContext = createContext<NativeUi | null>(null);
export function NativeSlot({ kind, props, className = "" }: { kind: string; props: Record<string, any>; className?: string }) {
  const ui = useContext(NativeUiContext), node = useRef<HTMLDivElement>(null);
  const instance = useRef<ReturnType<NativeUi["mount"]> | null>(null);
  const latest = useRef(props); latest.current = props;
  useLayoutEffect(() => {
    if (!ui || !node.current) return;
    const fieldset=node.current.closest("fieldset");
    const adapted=()=>({...latest.current,disabled:latest.current.disabled || !!fieldset?.disabled});
    instance.current = ui.mount(kind, node.current, adapted());
    const observer=new MutationObserver(()=>instance.current?.update(adapted()));
    if(fieldset) observer.observe(fieldset,{attributes:true,attributeFilter:["disabled"]});
    return () => { observer.disconnect();instance.current?.dispose(); instance.current = null; };
  }, [ui, kind]);
  useLayoutEffect(() => { instance.current?.update({...props,disabled:props.disabled || !!node.current?.closest("fieldset")?.disabled}); });
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
  const mapped = { ...props, id, size: "small", readonly: props.readOnly,
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
  const [label,setLabel]=useState(props["aria-label"] || "");
  useLayoutEffect(()=>{
    const node=outer.current?.closest("label") || (props.id ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(props.id)}"]`) : null);
    if(node && !props["aria-label"]) setLabel([...node.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join(" ").trim());
  },[props["aria-label"],props.id]);
  if (!ui) return <select {...props} />;
  const items = options(props.children);
  const value = String(props.value ?? props.defaultValue ?? items[0]?.value ?? "");
  const id = props.id || `dc-select-${generated.replace(/[^a-zA-Z0-9-]/g, "")}`;
  const change = (next: string) => props.onChange?.({ target: { value: next }, currentTarget: { value: next } } as any);
  return <div ref={outer} className="dc-select-control">
    <NativeSlot kind="select" props={{ id, value, items, onChange: change, disabled: props.disabled,
      "aria-label": label, "aria-labelledby": props["aria-labelledby"], "aria-describedby": props["aria-describedby"],
      "aria-invalid": props["aria-invalid"], size: "small", className: "dc-native-select" }} />
    {props.required && <select className="dc-validity" aria-hidden="true" tabIndex={-1} required value={value} disabled={props.disabled}
      onChange={props.onChange} onInvalid={()=>document.getElementById(id)?.focus()}>{props.children}</select>}
  </div>;
}

export function NativeSidebar({children}:{children:ReactNode}) {
  const [node,setNode]=useState<HTMLElement|null>(null);
  return <><NativeSlot kind="sidebar" props={{className:"dc-native-sidebar",contentRef:setNode}} />{node && createPortal(children,node)}</>;
}
