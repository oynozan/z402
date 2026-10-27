import { LightwalletdTxStatus } from "@z402/client";
import { createLightwalletdClient } from "@z402/lightwalletd";

/** Chain status reads through the facilitator agent's lightwalletd client, pointed at a local Zaino. */
export function zainoTxStatus(url: string): { status: LightwalletdTxStatus; close(): void } {
  const lwd = createLightwalletdClient({ url });
  return { status: new LightwalletdTxStatus(lwd), close: () => lwd.close() };
}
