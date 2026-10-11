import { useContext, useId, useRef, useState } from "react";
import { Check } from "lucide-react";
import { NativeControl, NativeControls } from "./NativeAlertControls";
export type AlertMenuItem = {
  label: string;
  run: () => void;
  checked?: boolean;
  disabled?: boolean;
  divider?: boolean;
};
export function AlertMenu({
  label,
  children,
  items,
}: {
  label: string;
  children?: React.ReactNode;
  items: AlertMenuItem[];
}) {
  const factory = useContext(NativeControls);
  return factory ? (
    <NativeAlertMenu label={label} items={items}>
      {children}
    </NativeAlertMenu>
  ) : (
    <FallbackAlertMenu label={label} items={items}>
      {children}
    </FallbackAlertMenu>
  );
}
function NativeAlertMenu({
  label,
  children,
  items,
}: {
  label: string;
  children?: React.ReactNode;
  items: AlertMenuItem[];
}) {
  const trigger = useRef<HTMLButtonElement>(null),
    [opened, setOpened] = useState(false);
  return (
    <span className="alert-menu-wrap">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={opened}
        onClick={() => setOpened((value) => !value)}
      >
        {children || label}
      </button>
      <NativeControl
        kind="menu"
        properties={{
          label,
          items,
          anchor: trigger.current,
          opened,
          onClose: () => setOpened(false),
        }}
      />
    </span>
  );
}
function FallbackAlertMenu({
  label,
  children,
  items,
}: {
  label: string;
  children?: React.ReactNode;
  items: AlertMenuItem[];
}) {
  const id = useId(),
    popover = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  return (
    <span className="alert-menu-wrap">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        popoverTarget={id}
        onClick={() => {
          const box = trigger.current!.getBoundingClientRect(),
            node = popover.current!;
          node.style.left =
            Math.max(
              8,
              Math.min(
                box.left,
                node.ownerDocument.defaultView!.innerWidth - 240,
              ),
            ) + "px";
          node.style.top =
            Math.max(
              8,
              Math.min(
                box.bottom + 4,
                node.ownerDocument.defaultView!.innerHeight -
                  Math.min(400, items.length * 34 + 8) -
                  8,
              ),
            ) + "px";
        }}
      >
        {children || label}
      </button>
      <div
        ref={popover}
        id={id}
        popover="auto"
        className="alert-menu"
        role="menu"
        aria-label={label}
        onToggle={(event) => {
          if ((event as any).newState === "open")
            popover.current
              ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
              ?.focus();
        }}
        onKeyDown={(event) => {
          const buttons = [
            ...popover.current!.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          ];
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          let next = index;
          if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
          else if (event.key === "ArrowUp")
            next = (index - 1 + buttons.length) % buttons.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = buttons.length - 1;
          else return;
          event.preventDefault();
          buttons[next]?.focus();
        }}
      >
        {items.map((item, index) => (
          <button
            key={index}
            type="button"
            className={item.divider ? "alert-menu-divider" : ""}
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={item.checked}
            disabled={item.disabled}
            onClick={() => {
              popover.current?.hidePopover();
              trigger.current?.focus();
              item.run();
            }}
          >
            <span>{item.label}</span>
            {item.checked && <Check size={16} aria-hidden />}
          </button>
        ))}
      </div>
    </span>
  );
}
