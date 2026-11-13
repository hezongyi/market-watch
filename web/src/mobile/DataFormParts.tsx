import { useId, type ReactNode } from "react";
import { ChevronDown, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Field, FieldLabel } from "./components/ui/field";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
import MobileSelect from "./MobileSelect";

export function DataFeedback({
  error,
  notice,
}: {
  error?: string;
  notice?: string;
}) {
  return error || notice ? (
    <Alert
      variant={error ? "destructive" : "default"}
      className="data-feedback"
      role={error ? "alert" : "status"}
    >
      <Info aria-hidden="true" />
      <AlertTitle>{error ? "需要处理" : "操作状态"}</AlertTitle>
      <AlertDescription>{error || notice}</AlertDescription>
    </Alert>
  ) : null;
}
export function DataInput({
  label,
  ...props
}: React.ComponentProps<typeof Input> & { label: string }) {
  const id = useId();
  return (
    <Field data-invalid={props["aria-invalid"] || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input {...props} id={id} />
    </Field>
  );
}
export function DataSelect({
  label,
  ...props
}: React.ComponentProps<typeof MobileSelect>) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <MobileSelect {...props} label={label} id={id} />
    </Field>
  );
}
export function DataFrames({
  frames,
  value,
  change,
  disabled,
  required,
}: {
  frames: string[];
  value: string[];
  change(value: string[]): void;
  disabled?: boolean;
  required?: string;
}) {
  return (
    <Field>
      <FieldLabel>维护周期</FieldLabel>
      <ToggleGroup
        multiple
        aria-label="维护周期"
        className="data-frame-options"
        variant="outline"
        value={value}
        disabled={disabled}
        onValueChange={(next) =>
          change(
            frames.filter(
              (frame) => frame === required || next.includes(frame),
            ),
          )
        }
      >
        {frames.map((frame) => (
          <ToggleGroupItem
            value={frame}
            key={frame}
            disabled={disabled || frame === required}
          >
            {frame}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  );
}
export function DataMore({
  title = "更多设置",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible className="data-more">
      <CollapsibleTrigger render={<Button variant="ghost" />}>
        {title}
        <ChevronDown data-icon="inline-end" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
