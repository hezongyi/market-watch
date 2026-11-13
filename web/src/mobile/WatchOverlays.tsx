import {
  createContext, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from "react";
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import { X } from "lucide-react";
import { Drawer, DrawerContent, DrawerTitle, DrawerDescription } from "./components/ui/drawer";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { Button } from "./components/ui/button";
import type { MobileSheetProps } from "./MobileSheet";

// Opt-in page providers keep portals inside the current theme and mobile control scope.
const WatchOverlays = createContext<{ container: HTMLDivElement | null } | null>(null);
export const useWatchOverlays = () => useContext(WatchOverlays);
export const MOBILE_OVERLAYS = 'dialog.mobile-sheet[open], [data-mobile-overlay="true"]';

export function WatchOverlaysProvider({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ container }), [container]);
  return <WatchOverlays.Provider value={value}>
    {children}
    <div className="mobile-overlays" ref={setContainer} />
  </WatchOverlays.Provider>;
}

export function useOverlayBack(element: RefObject<HTMLElement | null>, leave: () => void) {
  const latest = useRef(leave);
  latest.current = leave;
  useEffect(() => {
    const back = (event: Event) => {
      if ([...document.querySelectorAll(MOBILE_OVERLAYS)].at(-1) !== element.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      latest.current();
    };
    addEventListener("mw-mobile-back", back, true);
    return () => removeEventListener("mw-mobile-back", back, true);
  }, [element]);
}

export function WatchDrawer(props: MobileSheetProps) {
  const { open = true } = props;
  // Keep the last open view during exit; don't flash another panel or empty its form.
  const lastOpen = useRef(props);
  if (open) lastOpen.current = props;
  const { title, description, children, dirty, close, onClosed, fullHeight, dismissible = true } = lastOpen.current;
  const host = useWatchOverlays();
  const popup = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  if (open) opened.current = true;
  const [discard, setDiscard] = useState(false);
  const leave = () => {
    if (!open || !dismissible) return;
    if (dirty) setDiscard(true);
    else close();
  };
  useOverlayBack(popup, leave);
  if (!host?.container) return null;
  return <Drawer
    open={open}
    showSwipeHandle
    onOpenChange={(next, details) => {
      if (next) return;
      if (!dismissible) { details.cancel(); return; }
      if (dirty) { details.cancel(); setDiscard(true); }
      else close();
    }}
    onOpenChangeComplete={next => {
      if (!next && opened.current) {
        opened.current = false;
        onClosed?.();
      }
    }}
  >
    <DrawerPrimitive.VirtualKeyboardProvider>
      <DrawerContent
        ref={popup}
        container={host.container}
        className="mobile-sheet mobile-control-drawer"
        data-mobile-overlay="true"
        data-mobile-dirty={dirty || undefined}
        data-full-height={fullHeight || undefined}
        initialFocus={popup}
      >
        <header className="mobile-drawer-header">
          <div>
            <DrawerTitle>{title}</DrawerTitle>
            {description && <DrawerDescription>{description}</DrawerDescription>}
          </div>
          <Button variant="ghost" size="icon" aria-label="关闭" disabled={!dismissible} onClick={leave}>
            <X aria-hidden="true" />
          </Button>
        </header>
        <div className="mobile-sheet-body mobile-drawer-scroll" key={title}>
          {children}
        </div>
        {discard && <WatchConfirm
          title="放弃本次修改？"
          description="本次更改尚未保存，放弃后将丢失。"
          actionLabel="放弃修改"
          cancelLabel="继续编辑"
          destructive
          onClose={() => setDiscard(false)}
          onAccept={() => { setDiscard(false); close(); }}
        />}
      </DrawerContent>
    </DrawerPrimitive.VirtualKeyboardProvider>
  </Drawer>;
}

export function WatchConfirm({
  title, description, actionLabel, cancelLabel = "取消", destructive = false, onAccept, onClose,
}: {
  title: string; description: string; actionLabel: string; cancelLabel?: string;
  destructive?: boolean; onAccept(): void; onClose(): void;
}) {
  const [open, setOpen] = useState(true);
  const accepted = useRef(false);
  const popup = useRef<HTMLDivElement>(null);
  const host = useWatchOverlays();
  useOverlayBack(popup, () => setOpen(false));
  return <AlertDialog open={open} onOpenChange={setOpen}
    onOpenChangeComplete={next => { if (!next) { if (accepted.current) onAccept(); else onClose(); } }}>
    <AlertDialogContent container={host?.container} ref={popup} className="mobile-confirm" size="sm" data-mobile-overlay="true">
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
        <AlertDialogAction variant={destructive ? "destructive" : "default"}
          onClick={() => { accepted.current = true; setOpen(false); }}>{actionLabel}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

// Shared aliases preserve existing Watch imports while More opts into the same controls.
export { WatchOverlaysProvider as MobileOverlaysProvider, WatchConfirm as MobileConfirm };
