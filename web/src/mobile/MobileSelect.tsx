import { useRef, useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { useOverlayBack, useWatchOverlays } from "./WatchOverlays";

/** Keep themed menus, notifications and Android back inside the current mobile surface. */
export default function MobileSelect({
  label,
  value,
  onChange,
  items,
  disabled,
  id,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  items: { value: string; label: string }[];
  disabled?: boolean;
  id?: string;
}) {
  const host = useWatchOverlays();
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useOverlayBack(popup, () => setOpen(false));
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(String(next));
      }}
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
    >
      <SelectTrigger id={id} aria-label={label}>
        <SelectValue>{items.find((item) => item.value === value)?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent
        ref={popup}
        container={host?.container}
        alignItemWithTrigger={false}
        data-mobile-overlay={open ? "true" : undefined}
        className="watch-select-popup"
      >
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
