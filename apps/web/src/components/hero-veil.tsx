"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Tip } from "./tip";

const DitherVeil = dynamic(() => import("./dither-veil/DitherVeil"), { ssr: false });

/** coin.png is 1600 by 1100 */
const PICTURE_ASPECT = 1600 / 1100;
const GRID = 60;

/** pay.sh's grid tiles as [column, row, kind], a negative column counting back from the last whole one */
const TILES: [number, number, "hatch" | "dots"][] = [
  [1, 0, "hatch"],
  [-2, 1, "dots"],
  [0, 9, "dots"],
  [-1, 10, "hatch"],
];

/** With fewer whole columns the coin fills the cell and the right-hand tiles would sit on it */
const RIGHT_TILES_MIN_COLUMNS = 12;

interface Cell {
  /** The fit that makes the picture exactly as tall as the box, which is where the stylesheet expects the coin's rim */
  fit: "contain" | "cover";
  columns: number;
  rows: number;
}

function useCell(box: RefObject<HTMLDivElement | null>): Cell | null {
  const [cell, setCell] = useState<Cell | null>(null);
  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      if (height <= 0) return;
      const next: Cell = {
        fit: width / height < PICTURE_ASPECT ? "cover" : "contain",
        columns: Math.floor(width / GRID),
        rows: Math.floor(height / GRID),
      };
      setCell((c) => (c?.fit === next.fit && c.columns === next.columns && c.rows === next.rows ? c : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [box]);
  return cell;
}

/** Where a tile lands on the measured grid, or null when it would be cut by an edge or crowd the coin */
function place([column, row]: [number, number, unknown], cell: Cell | null): [number, number] | null {
  if (column >= 0) return cell === null || (column < cell.columns && row < cell.rows) ? [column, row] : null;
  if (cell === null || cell.columns < RIGHT_TILES_MIN_COLUMNS || row >= cell.rows) return null;
  return [cell.columns + column, row];
}

/** The veil only draws in the browser, and its cell keeps its size from the first paint */
export function HeroVeil() {
  const box = useRef<HTMLDivElement>(null);
  const cell = useCell(box);
  return (
    <div className="veil" ref={box}>
      <DitherVeil
        src="/coin.png"
        fit={cell?.fit ?? "contain"}
        pattern="bayer"
        pixelSize={2}
        // The cell's own black, so the picture's ground and the page are one colour
        inkColor="#000000"
        paperColor="#ffffff"
        // Without it the revealed ground lands half a level above the ink and shows as a faint disc
        brightness={-0.02}
        revealRadius={190}
        softness={0.6}
        linger={1}
        wander
        clickBurst={false}
      />
      <div className="grid-bg" aria-hidden="true">
        {TILES.map((tile) => {
          const at = place(tile, cell);
          if (at === null) return null;
          return (
            <span
              key={`${tile[0]}-${tile[1]}`}
              className={`grid-tile grid-tile-${tile[2]}`}
              style={{ "--x": at[0], "--y": at[1] } as CSSProperties}
            />
          );
        })}
      </div>
      <div className="veil-tip">
        <Tip label="About the coin">
          Shielded by default.
          <br />
          A viewing key reveals it.
        </Tip>
      </div>
    </div>
  );
}
