import { useRef, useState } from "react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "./components/ui/select";
import { useWatchOverlays, useOverlayBack } from "./WatchOverlays";

export default function WatchGroupSelect({ value, onChange, groups, disabled }: {
  value: string; onChange(value: string): void;
  groups: { id: string; title: string }[]; disabled?: boolean;
}) {
  const host = useWatchOverlays();
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useOverlayBack(popup, () => setOpen(false));
  const items = [{ value: "", label: "默认自选列表" }, ...groups.map(group => ({ value: group.id, label: group.title }))];
  return <Select items={items} value={value} onValueChange={next => onChange(String(next))}
    open={open} onOpenChange={setOpen} disabled={disabled}>
    <SelectTrigger aria-label="添加到分组"><SelectValue /></SelectTrigger>
    <SelectContent ref={popup} container={host?.container} alignItemWithTrigger={false}
      data-mobile-overlay={open ? "true" : undefined} className="watch-select-popup">
      <SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup>
    </SelectContent>
  </Select>;
}
