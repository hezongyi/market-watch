import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Shrink inside a fixed column; neither long codes nor quotes can steal chart width. */
export default function FitText({ text, children }: { text: string; children?: ReactNode }) {
  const box = useRef<HTMLSpanElement>(null), content = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const outer = box.current!, inner = content.current!;
    let width = -1, active = true;
    const fit = () => {
      if (!active) return;
      const available = outer.getBoundingClientRect().width;
      if (!available) return;
      width = available;
      inner.style.fontSize = "1em";
      let scale = 1;
      // Letter spacing/superscript margins need a second measurement after scaling.
      for (let pass = 0; pass < 3; pass++) {
        const natural = inner.getBoundingClientRect().width;
        if (natural <= available) break;
        scale *= (available - 0.25) / Math.max(1, natural);
        inner.style.fontSize = scale + "em";
      }
    };
    const observer = new ResizeObserver(entries => {
      if (Math.abs(entries[0].contentRect.width - width) > 0.1) fit();
    });
    observer.observe(outer);
    fit();
    void document.fonts.ready.then(fit);
    return () => { active = false; observer.disconnect(); };
  }, [text]);
  return <span ref={box} className="mobile-fit-text"><span ref={content} className="mobile-fit-content">{children ?? text}</span></span>;
}
