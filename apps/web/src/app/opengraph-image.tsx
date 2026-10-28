import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { GOLD, MARK_PATH } from "@/lib/mark";

/**
 * The share image: the site's black, a hairline frame like its rails and section lines, the mark and the wordmark at
 * the top as in the header, and the footer's line set like the hero's title. Manrope comes from src/app/fonts, cut to
 * Basic Latin (SIL Open Font License, OFL.txt there), since the image is drawn at build time with no network.
 */

export const alt = "z402: shielded x402 payments for AI agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const fonts = join(process.cwd(), "src/app/fonts");
const [medium, semibold] = await Promise.all([
  readFile(join(fonts, "Manrope-500.ttf")),
  readFile(join(fonts, "Manrope-600.ttf")),
]);

const LINE = "#ffffff14";
/** Where the rails and the section lines cross the frame, and the cell's inset inside them */
const EDGE = 56;
const INSET = 48;
/**
 * The wordmark's size, and the mark as tall as its figures (0.72 em, 3.5px a unit of its 16), as far from them as in
 * the header
 */
const WORD = 78;
const MARK = 56;

export default function Image() {
  return new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%", position: "relative", background: "#000" }}>
      <div style={{ position: "absolute", top: 0, bottom: 0, left: EDGE, width: 1, background: LINE }} />
      <div style={{ position: "absolute", top: 0, bottom: 0, right: EDGE, width: 1, background: LINE }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: EDGE, height: 1, background: LINE }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: EDGE, height: 1, background: LINE }} />
      <div
        style={{
          position: "absolute",
          top: EDGE + 1 + INSET,
          left: EDGE + 1 + INSET,
          right: EDGE + INSET,
          bottom: EDGE + INSET,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 31 }}>
          <svg width={MARK} height={MARK} viewBox="0 0 16 16" style={{ marginTop: 13 }}>
            <path d={MARK_PATH} fill={GOLD} />
          </svg>
          <div
            style={{
              color: "#fff",
              fontFamily: "Manrope",
              fontWeight: 600,
              fontSize: WORD,
              lineHeight: 1,
              letterSpacing: "-0.04em",
            }}
          >
            z402
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            color: "#fff",
            fontFamily: "Manrope",
            fontWeight: 500,
            fontSize: 64,
            lineHeight: "68px",
            letterSpacing: "-0.02em",
          }}
        >
          <div>Shielded x402 payments</div>
          <div>for AI agents.</div>
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Manrope", data: medium, weight: 500, style: "normal" },
        { name: "Manrope", data: semibold, weight: 600, style: "normal" },
      ],
    },
  );
}
