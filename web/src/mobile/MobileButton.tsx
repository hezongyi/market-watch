import type { ComponentProps } from "react";
import { Button } from "./components/ui/button";
import { useWatchOverlays } from "./WatchOverlays";

// Shared DataPage keeps its existing controls outside the Watch migration scope.
export default function MobileButton({ variant = "outline", size, ...props }:
  ComponentProps<"button"> & Pick<ComponentProps<typeof Button>, "variant" | "size">) {
  const watch = useWatchOverlays();
  return watch ? <Button variant={variant} size={size} {...props} /> : <button {...props} />;
}
