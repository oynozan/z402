"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import { Tip } from "./tip";

const DitherVeil = dynamic(() => import("./dither-veil/DitherVeil"), { ssr: false });

/** Up to here the box is narrower than the 1600 by 1100 picture, so cover is what fits it to the box height */
const NARROW = "(max-width: 476px)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The picture always fills the box height, which is where the stylesheet expects the coin's rim */
function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

/** The veil only draws in the browser, so its box holds the space from the first paint */
export function HeroVeil() {
  const narrow = useNarrow();
  return (
    <div className="veil rise rise-4">
      <div className="veil-art">
        <DitherVeil
          src="/coin.png"
          fit={narrow ? "cover" : "contain"}
          pattern="bayer"
          pixelSize={2}
          inkColor="#161616"
          paperColor="#ededeb"
          // Without it the revealed ground lands half a level above the page and shows as a faint disc
          brightness={-0.02}
          revealRadius={170}
          softness={0.6}
          linger={1}
          wander
          clickBurst={false}
        />
      </div>
      <div className="veil-tip">
        <Tip label="About the coin">
          {"Shielded by default. "}
          <br />
          A viewing key reveals it.
        </Tip>
      </div>
    </div>
  );
}
