"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

/** A chunk that fails to load leaves no rays rather than taking the page down with it */
const LightRays = dynamic(() => import("./light-rays/LightRays").catch(() => ({ default: () => null })), {
  ssr: false,
});

const REDUCED = "(prefers-reduced-motion: reduce)";

function onReducedChange(notify: () => void) {
  const query = window.matchMedia(REDUCED);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

const isReduced = () => window.matchMedia(REDUCED).matches;
const hasWebgl2 = () => typeof WebGL2RenderingContext !== "undefined";
const never = () => () => {};

/**
 * True once the box is within a quarter screen of the viewport and the main thread is idle, so the rays start as the
 * section nears and never in the same task as the page's own start
 */
function useNear(box: RefObject<HTMLDivElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (element === null || near) return;
    const idle = typeof window.requestIdleCallback === "function";
    let pending = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || pending !== 0) return;
        const start = () => setNear(true);
        pending = idle ? window.requestIdleCallback(start, { timeout: 500 }) : window.setTimeout(start, 50);
      },
      { rootMargin: "25% 0px" },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (idle) window.cancelIdleCallback(pending);
      else window.clearTimeout(pending);
    };
  }, [box, near]);
  return near;
}

/**
 * React Bits' Light Rays, white and faint, behind the services section's head, decoration only: they never follow,
 * shade or answer the cursor, and the component listens for no pointer at all. They render in the browser once the
 * section nears, pause offscreen and in a hidden tab (the component's own observers), hold one still frame under
 * reduced motion, and without WebGL2 leave a faint glow in their place.
 */
export function ServicesRays() {
  const box = useRef<HTMLDivElement>(null);
  const near = useNear(box);
  const reduced = useSyncExternalStore(onReducedChange, isReduced, () => false);
  const webgl = useSyncExternalStore(never, hasWebgl2, () => true);
  const [failed, setFailed] = useState(false);
  const fallback = !webgl || failed;
  return (
    <div ref={box} className="rays" data-fallback={fallback ? "" : undefined} aria-hidden="true">
      {near && !fallback && (
        <LightRays
          raysOrigin="top-center"
          raysColor="#ffffff"
          raysSpeed={reduced ? 0 : 0.6}
          lightSpread={0.7}
          rayLength={1.6}
          glow={0.4}
          atmosphere={0}
          intensity={0.8}
          opacity={0.45}
          followMouse={false}
          mouseInfluence={0}
          cursorShadow={false}
          clickPulse={false}
          intro={!reduced}
          maxDevicePixelRatio={1.5}
          onUnsupported={() => setFailed(true)}
        />
      )}
    </div>
  );
}
