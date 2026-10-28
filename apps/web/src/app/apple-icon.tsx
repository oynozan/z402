import { ImageResponse } from "next/og";
import { GOLD, MARK_PATH } from "@/lib/mark";

/** The home screen icon: the mark on the site's black, 7px a unit of its 16, with room for the platform's corners */

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        background: "#000",
      }}
    >
      <svg width={112} height={112} viewBox="0 0 16 16">
        <path d={MARK_PATH} fill={GOLD} />
      </svg>
    </div>,
    size,
  );
}
