import type { Response } from "express";

export interface DeliveryHandlers {
  /** The response finished with a 2xx, so a paid call was settled and handed to the client */
  ok?: () => void;
  /** Anything else: a refused settle, a handler error or a connection that closed first */
  failed?: () => void;
}

/**
 * Runs exactly one of the handlers once the response is over. The x402 middleware settles after the handler and turns
 * a refused settle into a 402, so a 2xx at the end is the only sign that the call was paid and delivered.
 */
export function onDelivered(res: Response, h: DeliveryHandlers): void {
  let done = false;
  const end = (delivered: boolean): void => {
    if (done) return;
    done = true;
    try {
      (delivered ? h.ok : h.failed)?.();
    } catch (e) {
      console.error("delivery handler failed", e);
    }
  };
  const succeeded = (): boolean => res.statusCode >= 200 && res.statusCode < 300;
  // Node does not replay "finish" or "close" for a response that is already over
  if (res.closed) {
    end(res.writableFinished && succeeded());
    return;
  }
  res.once("finish", () => end(succeeded()));
  res.once("close", () => end(res.writableFinished && succeeded()));
}
