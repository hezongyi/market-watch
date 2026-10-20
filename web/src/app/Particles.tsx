/*! Magic UI Particles adaptation. MIT license, copyright (c) Magic UI.
 * Full license and pinned source: /MAGIC_UI_LICENSE.md. */
import { useEffect, useRef, type RefObject } from "react";
import "./particles.css";

type Circle = {
  x: number;
  y: number;
  translateX: number;
  translateY: number;
  size: number;
  alpha: number;
  targetAlpha: number;
  dx: number;
  dy: number;
  magnetism: number;
  phase: number;
  period: number;
};

type Props = {
  theme: "dark" | "light";
  paused: boolean;
  quietAreaRef: RefObject<HTMLElement | null>;
};

// One small canvas; no React state updates during drawing or pointer movement.
const MAX_PARTICLES = 96;
const FRAME_INTERVAL = 1000 / 24;
const MAX_PIXELS = 3_000_000;

export function Particles({ theme, paused, quietAreaRef }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settings = useRef({ theme, paused });
  const synchronize = useRef<() => void>(() => {});

  useEffect(() => {
    settings.current = { theme, paused };
    synchronize.current();
  }, [theme, paused]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!host || !canvas || !context) return;

    let width = 0,
      height = 0,
      dpr = 1;
    let circles: Circle[] = [];
    let quiet = { left: 0, top: 0, right: 0, bottom: 0 };
    let mouse = { x: 0, y: 0 };
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastTime = 0;
    let elapsed = 0;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const canAnimate = () =>
      !settings.current.paused && !document.hidden && !media.matches;

    const circleParams = (): Circle => ({
      x: Math.random() * width,
      y: Math.random() * height,
      translateX: 0,
      translateY: 0,
      size: 0.65 + Math.random() * 0.8,
      alpha: 0,
      targetAlpha: 0.28 + Math.random() * 0.32,
      dx: (Math.random() - 0.5) * 0.1,
      dy: (Math.random() - 0.5) * 0.1 - 0.012,
      magnetism: 0.3 + Math.random() * 0.7,
      phase: Math.random() * Math.PI * 2,
      period: 12 + Math.random() * 12,
    });

    const drawCircle = (circle: Circle) => {
      const x = circle.x + circle.translateX;
      const y = circle.y + circle.translateY;
      // Upstream edge fade, plus a slow, shallow opacity cycle.
      const edge = Math.min(x, width - x, y, height - y);
      const edgeAlpha = Math.max(0, Math.min(1, edge / 28));
      const distance = Math.hypot(
        Math.max(quiet.left - x, 0, x - quiet.right),
        Math.max(quiet.top - y, 0, y - quiet.bottom),
      );
      const quietAlpha = 0.12 + 0.88 * Math.min(1, distance / 120);
      const breath =
        0.78 +
        0.22 * Math.sin(circle.phase + (elapsed * Math.PI * 2) / circle.period);
      circle.alpha = circle.targetAlpha * edgeAlpha * quietAlpha * breath;
      context.beginPath();
      context.arc(x, y, circle.size, 0, Math.PI * 2);
      context.fillStyle =
        settings.current.theme === "dark"
          ? `rgba(191, 195, 202, ${circle.alpha})`
          : `rgba(91, 98, 108, ${circle.alpha * 0.7})`;
      context.fill();
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      circles.forEach(drawCircle);
    };

    const stop = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      timer = undefined;
      frame = 0;
      lastTime = 0;
    };

    const schedule = () => {
      timer = setTimeout(() => {
        timer = undefined;
        frame = requestAnimationFrame(animate);
      }, FRAME_INTERVAL);
    };

    const animate = (now: number) => {
      frame = 0;
      if (!canAnimate()) {
        stop();
        return;
      }
      const seconds = lastTime
        ? Math.min((now - lastTime) / 1000, 0.1)
        : FRAME_INTERVAL / 1000;
      lastTime = now;
      elapsed += seconds;
      const step = seconds * 60;
      const easing = 1 - Math.exp(-seconds * 1.4);
      circles.forEach((circle, i) => {
        circle.x += circle.dx * step;
        circle.y += circle.dy * step;
        // Upstream mouse easing, clamped to a maximum two CSS pixels.
        circle.translateX +=
          (mouse.x * circle.magnetism - circle.translateX) * easing;
        circle.translateY +=
          (mouse.y * circle.magnetism - circle.translateY) * easing;
        if (
          circle.x < -circle.size ||
          circle.x > width + circle.size ||
          circle.y < -circle.size ||
          circle.y > height + circle.size
        ) {
          circles[i] = circleParams();
        }
      });
      draw();
      schedule();
    };

    const sync = () => {
      stop();
      if (document.hidden) return;
      draw(); // Paused/reduced motion still gets a visible static background.
      if (canAnimate()) schedule();
    };
    synchronize.current = sync;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      const card = quietAreaRef.current?.getBoundingClientRect();
      if (card)
        quiet = {
          left: card.left - rect.left,
          top: card.top - rect.top,
          right: card.right - rect.left,
          bottom: card.bottom - rect.top,
        };
      if (rect.width <= 0 || rect.height <= 0) {
        stop();
        return;
      }
      const nextDpr = Math.min(
        window.devicePixelRatio || 1,
        1.5,
        Math.sqrt(MAX_PIXELS / (rect.width * rect.height)),
      );
      if (width !== rect.width || height !== rect.height || dpr !== nextDpr) {
        width = rect.width;
        height = rect.height;
        dpr = nextDpr;
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        const quantity = Math.min(
          MAX_PARTICLES,
          Math.max(18, Math.round((width * height) / 12500)),
        );
        circles = Array.from({ length: quantity }, circleParams);
      }
      sync();
    };

    const pointerMove = (event: PointerEvent) => {
      if (!canAnimate() || event.pointerType !== "mouse") return;
      // Bounded to the viewport: no per-event DOM reads or component rerenders.
      mouse = {
        x: Math.max(
          -2,
          Math.min(2, (event.clientX / window.innerWidth - 0.5) * 4),
        ),
        y: Math.max(
          -2,
          Math.min(2, (event.clientY / window.innerHeight - 0.5) * 4),
        ),
      };
    };
    const resetPointer = () => {
      mouse = { x: 0, y: 0 };
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    if (quietAreaRef.current) observer.observe(quietAreaRef.current);
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", pointerMove, { passive: true });
    document.addEventListener("mouseleave", resetPointer);
    document.addEventListener("visibilitychange", sync);
    media.addEventListener("change", sync);
    resize();
    return () => {
      stop();
      synchronize.current = () => {};
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", pointerMove);
      document.removeEventListener("mouseleave", resetPointer);
      document.removeEventListener("visibilitychange", sync);
      media.removeEventListener("change", sync);
    };
  }, [quietAreaRef]);

  return (
    <div className="login-particles" ref={hostRef} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
