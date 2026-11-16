import type { ComponentProps } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "./ui/button";

/** Shared page/drawer action: fixed touch target, quiet icon, effective-filter marker. */
export function HeaderIconButton({
  icon: Icon,
  label,
  active = false,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "className" | "variant" | "size" | "aria-label"> & {
  icon: LucideIcon;
  label: string;
  active?: boolean;
}) {
  return (
    <Button
      {...props}
      variant="plain"
      size="icon"
      className="mobile-header-icon"
      aria-label={label}
      data-active={active || undefined}
    >
      <Icon aria-hidden="true" data-icon="inline-start" strokeWidth={1.75} />
      {active && <span className="mobile-header-icon-dot" aria-hidden="true" />}
    </Button>
  );
}
