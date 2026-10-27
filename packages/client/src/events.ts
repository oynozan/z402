import type { SessionSnapshot } from "@z402/protocol";

/** What `onEvent` receives, for the demo log and tests (design §3.6), amounts are zat strings */
export type ClientEvent =
  | { type: "session"; network: string; payTo: string; sessionKey: string }
  | { type: "deposit_started"; index: number; inline: boolean }
  | { type: "deposit_broadcast"; index: number; txid: string; ms: number }
  | { type: "deposit_failed"; index: number; error: Error }
  | { type: "deposit_acked"; txid: string }
  | { type: "deposit_confirmed"; txid: string; height: number }
  | { type: "deposit_dead"; txid: string }
  | { type: "voucher"; cumulativeZat: string; depositTxid?: string }
  | { type: "paid"; cumulativeZat: string; snapshot?: SessionSnapshot }
  | { type: "refused"; code: string; snapshot?: SessionSnapshot; recovering: boolean }
  | { type: "waiting"; txid: string }
  | { type: "ambiguous"; attemptedZat: string }
  | { type: "fatal"; code: string; message: string };
