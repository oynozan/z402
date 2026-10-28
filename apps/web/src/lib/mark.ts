/**
 * The z402 mark: a gold square cut in two by a Z, on a 16 unit grid. Its rows are 4, 2, 4, 2 and 4 units, so every
 * horizontal edge lands on a whole pixel at 16px, and the Z's diagonal runs at 45 degrees, 3 units across, about as
 * heavy as its 2 unit strokes. The two pieces turn into each other through half a turn. The favicon (icon.svg), the
 * share images and the hero's coin (scripts/render-coin.mjs) draw these pieces.
 */
export const MARK_PIECES = ["M0 0H16V10H7.5L13.5 4H0Z", "M0 6H8.5L2.5 12H16V16H0Z"] as const;

export const MARK_PATH = MARK_PIECES.join("");

/**
 * The header's cut, on a 15 unit grid with the middle row a unit shorter: at 15px it stands as tall as the wordmark's
 * figures, with every horizontal edge still on a whole pixel
 */
export const MARK_PATH_15 = "M0 0H15V9H7.5L12.5 4H0ZM0 6H7.5L2.5 11H15V15H0Z";

/** Zcash's gold, the site's --accent */
export const GOLD = "#f4b728";
