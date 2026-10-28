import type { TextMeasurer } from "pele";

/**
 * Text widths for Pele's layout on the server, where it has no canvas and would measure with Helvetica's metrics.
 * The diagrams are set in Manrope, which is narrower in its spaces and wider in its digits, so boxes sized by
 * Helvetica would crowd or clip their labels. Advance widths in thousandths of an em, measured in Chrome from
 * Manrope at 400 and 700 (Google Fonts), for U+0020 to U+007E and a few common symbols. Kerning is left out, which
 * errs a pixel or two wide.
 */

const REGULAR = [
  200, 313, 392, 920, 589, 901, 651, 213, 426, 426, 437, 577, 265, 420, 253, 387, 610, 390, 570, 553, 590, 578, 621, 502,
  580, 621, 299, 305, 614, 750, 614, 524, 904, 634, 613, 715, 671, 570, 503, 705, 685, 233, 464, 594, 510, 841, 684, 723,
  604, 723, 631, 616, 597, 702, 604, 936, 606, 556, 614, 407, 387, 407, 669, 660, 490, 556, 592, 554, 592, 585, 355, 592,
  594, 233, 250, 496, 233, 848, 594, 592, 592, 592, 361, 525, 401, 594, 508, 767, 527, 527, 530, 419, 253, 419, 662,
];

const BOLD = [
  200, 360, 467, 931, 628, 900, 668, 260, 453, 453, 465, 572, 303, 420, 303, 433, 658, 438, 595, 581, 609, 586, 622, 533,
  612, 622, 342, 343, 637, 750, 637, 553, 914, 671, 631, 738, 700, 585, 523, 732, 722, 280, 501, 647, 533, 855, 718, 749,
  638, 749, 660, 657, 607, 720, 641, 976, 655, 611, 663, 423, 433, 423, 680, 660, 539, 576, 616, 576, 617, 602, 378, 616,
  625, 280, 288, 538, 280, 899, 625, 618, 616, 617, 399, 541, 433, 625, 553, 802, 554, 559, 534, 449, 300, 449, 716,
];

const EXTRA_REGULAR: Record<string, number> = {
  "—": 780, "–": 540, "…": 632, "→": 1000, "←": 1000, "↔": 916, "↑": 709, "↓": 709, "×": 488, "·": 227, "•": 653,
  "≈": 549, "≤": 549, "≥": 549, "“": 372, "”": 372, "‘": 222, "’": 222, "€": 649, "£": 571, "©": 803, "°": 450, "±": 600,
  "✓": 764, "✗": 571,
};

const EXTRA_BOLD: Record<string, number> = {
  "—": 780, "–": 540, "…": 710, "→": 1000, "←": 1000, "↔": 975, "↑": 720, "↓": 720, "×": 507, "·": 267, "•": 703,
  "≈": 549, "≤": 549, "≥": 549, "“": 451, "”": 451, "‘": 284, "’": 284, "€": 683, "£": 571, "©": 886, "°": 450, "±": 600,
  "✓": 764, "✗": 571,
};

/** About the width of a lower case letter, for a character missing from the tables */
const FALLBACK = 560;
/** IBM Plex Mono advances every character by six tenths of an em */
const MONO = 600;

/** Pele's style bits, from its text/measurer Style enum */
const BOLD_BIT = 1;
const MONO_BIT = 4;

export const manropeMeasurer: TextMeasurer = {
  width(text: string, size: number, style: number): number {
    if ((style & MONO_BIT) !== 0) return (Array.from(text).length * MONO * size) / 1000;
    const bold = (style & BOLD_BIT) !== 0;
    const table = bold ? BOLD : REGULAR;
    const extra = bold ? EXTRA_BOLD : EXTRA_REGULAR;
    let total = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      total += code >= 0x20 && code <= 0x7e ? (table[code - 0x20] ?? FALLBACK) : (extra[ch] ?? FALLBACK);
    }
    return (total * size) / 1000;
  },
};
