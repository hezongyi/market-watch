import {
  Children,
  cloneElement,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  type CarouselApi,
} from "./ui/carousel";
import { SwipeTabsContext } from "./ui/tabs";

/** Shared Tabs presentation. Only the selected page may perform background work. */
export function TabsPanels({
  children,
  order,
}: {
  children: ReactNode;
  order?: string[];
}) {
  const context = useContext(SwipeTabsContext);
  if (!context) throw new Error("TabsPanels requires controlled swipe Tabs");
  const { root, value } = context;
  const panels = Children.toArray(children).filter(
    isValidElement,
  ) as ReactElement<{ value: string; keepMounted?: boolean }>[];
  if (order)
    panels.sort(
      (a, b) => order.indexOf(a.props.value) - order.indexOf(b.props.value),
    );
  const values = panels.map((panel) => panel.props.value);
  const [api, setApi] = useState<CarouselApi>();
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const latest = useRef({ values, value, reduced });
  latest.current = { values, value, reduced };
  const gesture = useRef<
    | { x: number; y: number; dx: number; start: number; cancelled: boolean }
    | undefined
  >(undefined);
  const initial = useRef(Math.max(0, values.indexOf(String(value))));
  const opts = useMemo(
    () => ({
      startIndex: initial.current,
      loop: false,
      duration: reduced ? 0 : 25,
      watchFocus: false,
      watchDrag: (
        _: NonNullable<CarouselApi>,
        event: MouseEvent | TouchEvent,
      ) => {
        const target = event.target;
        if (!(target instanceof Element)) return false;
        if (
          target.closest(
            'input, textarea, select, [contenteditable="true"], [role="slider"], [role="switch"], [role="checkbox"], [data-no-tab-swipe]',
          )
        )
          return false;
        const point = "touches" in event ? event.touches[0] : event;
        if (
          !point ||
          ("touches" in event && event.touches.length !== 1) ||
          point.clientX < 24 ||
          point.clientX > innerWidth - 24
        )
          return false;
        const panel = target.closest('[data-slot="tabs-content"]');
        for (
          let el: Element | null = target;
          el && el !== panel;
          el = el.parentElement
        ) {
          if (
            el.scrollWidth > el.clientWidth + 1 &&
            /auto|scroll/.test(getComputedStyle(el).overflowX)
          )
            return false;
        }
        gesture.current = {
          x: point.clientX,
          y: point.clientY,
          dx: 0,
          start: latest.current.values.indexOf(String(latest.current.value)),
          cancelled: false,
        };
        return true;
      },
    }),
    [reduced],
  );
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!api) return;
    const select = () => {
      // Embla selects its snap during release; commit after the short-drag guard.
      if (gesture.current) return;
      const { values, value } = latest.current;
      const next = values[api.selectedScrollSnap()];
      if (next === undefined || next === String(value)) return;
      const tab = [
        ...(root.current?.querySelectorAll<HTMLElement>("[data-tab-value]") ||
          []),
      ].find(
        (tab) =>
          tab.dataset.tabValue === next &&
          tab.closest('[data-slot="tabs"]') === root.current,
      );
      tab?.click();
      tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    const up = () => {
      const current = gesture.current;
      gesture.current = undefined;
      if (current) {
        const threshold = Math.max(
          48,
          Math.min(72, api.rootNode().clientWidth * 0.16),
        );
        const step =
          !current.cancelled && Math.abs(current.dx) >= threshold
            ? current.dx < 0
              ? 1
              : -1
            : 0;
        api.scrollTo(
          Math.max(
            0,
            Math.min(latest.current.values.length - 1, current.start + step),
          ),
          latest.current.reduced,
        );
      }
      select();
    };
    const reinit = () =>
      api.scrollTo(
        Math.max(
          0,
          latest.current.values.indexOf(String(latest.current.value)),
        ),
        true,
      );
    const measure = () => {
      const index = latest.current.values.indexOf(String(latest.current.value));
      const panel = api.slideNodes()[index]?.firstElementChild;
      if (panel)
        api
          .rootNode()
          .style.setProperty(
            "--tabs-panel-height",
            panel.getBoundingClientRect().height + "px",
          );
    };
    const observer = new ResizeObserver(measure);
    api.slideNodes().forEach((slide) => {
      if (slide.firstElementChild) observer.observe(slide.firstElementChild);
    });
    api
      .on("select", select)
      .on("pointerUp", up)
      .on("reInit", reinit)
      .on("settle", measure);
    measure();
    return () => {
      observer.disconnect();
      api
        .off("select", select)
        .off("pointerUp", up)
        .off("reInit", reinit)
        .off("settle", measure);
    };
  }, [api, root]);
  useEffect(() => {
    if (!api) return;
    const index = values.indexOf(String(value));
    if (index >= 0 && index !== api.selectedScrollSnap()) {
      gesture.current = undefined;
      api.scrollTo(index, reduced);
    }
    const panel = api.slideNodes()[index]?.firstElementChild;
    if (panel)
      api
        .rootNode()
        .style.setProperty(
          "--tabs-panel-height",
          panel.getBoundingClientRect().height + "px",
        );
  }, [api, value, reduced, values.join("\0")]);
  return (
    <Carousel
      className="mobile-tabs-carousel"
      opts={opts}
      setApi={setApi}
      role="presentation"
      aria-roledescription={undefined}
      onKeyDownCapture={undefined}
      onTouchMoveCapture={(event) => {
        const current = gesture.current;
        if (!current) return;
        if (event.touches.length !== 1) current.cancelled = true;
        else {
          current.dx = event.touches[0].clientX - current.x;
          const dy = event.touches[0].clientY - current.y;
          if (
            Math.max(Math.abs(current.dx), Math.abs(dy)) >= 12 &&
            Math.abs(current.dx) < Math.abs(dy) * 1.4
          )
            current.cancelled = true;
        }
      }}
      onMouseMoveCapture={(event) => {
        if (gesture.current)
          gesture.current.dx = event.clientX - gesture.current.x;
      }}
      onTouchCancelCapture={() => {
        if (gesture.current) gesture.current.cancelled = true;
      }}
    >
      <CarouselContent className="mobile-tabs-track">
        {panels.map((panel) => (
          <CarouselItem
            key={panel.props.value}
            className="mobile-tabs-slide"
            role="presentation"
            aria-roledescription={undefined}
            aria-hidden={panel.props.value !== value || undefined}
            inert={panel.props.value !== value || undefined}
          >
            {cloneElement(panel, { keepMounted: true })}
          </CarouselItem>
        ))}
      </CarouselContent>
    </Carousel>
  );
}
