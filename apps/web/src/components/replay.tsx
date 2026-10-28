"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

const STEP_MS = 2_800;

/** Names the current step in data-step while on screen, and none with reduced motion, leaving each panel as it ends */
export function Replay({ steps, children }: { steps: number; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<number | null>(null);

  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const motion = window.matchMedia("(prefers-reduced-motion: no-preference)");
    let visible = false;
    let timer: number | undefined;

    const run = () => {
      window.clearInterval(timer);
      if (!visible || !motion.matches || document.visibilityState !== "visible") {
        setStep(null);
        return;
      }
      setStep(1);
      timer = window.setInterval(() => setStep((s) => ((s ?? 0) % steps) + 1), STEP_MS);
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        const now = entry?.isIntersecting ?? false;
        if (now === visible) return;
        visible = now;
        run();
      },
      // A band through the middle of the screen, which a list taller than the screen still crosses
      { rootMargin: "-35% 0px -35% 0px" },
    );
    observer.observe(element);
    motion.addEventListener("change", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.clearInterval(timer);
      observer.disconnect();
      motion.removeEventListener("change", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, [steps]);

  return (
    <div ref={root} className="replay" data-step={step ?? undefined}>
      {children}
    </div>
  );
}
