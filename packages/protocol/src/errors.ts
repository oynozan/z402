import type { ReasonCode } from "./reasons.js";

export class ProtocolError extends Error {
  readonly code: ReasonCode;

  constructor(code: ReasonCode, message: string = code) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/** Thrown by every chain reader on transport errors, as opposed to a definitive answer. */
export class ChainUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChainUnavailableError";
  }
}
