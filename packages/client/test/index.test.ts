import * as protocol from "@z402/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as client from "../src/index.js";

describe("@z402/client exports", () => {
  it("re-exports the protocol's ChainUnavailableError, so a custom chain source and the scheme agree on it", () => {
    expect(client.ChainUnavailableError).toBe(protocol.ChainUnavailableError);
  });

  it("re-exports the seam types a custom wallet or chain source implements", () => {
    expectTypeOf<client.ZcashWallet>().toEqualTypeOf<protocol.ZcashWallet>();
    expectTypeOf<client.DepositRequest>().toEqualTypeOf<protocol.DepositRequest>();
    expectTypeOf<client.TxStatusSource>().toEqualTypeOf<protocol.TxStatusSource>();
    expectTypeOf<client.TxStatus>().toEqualTypeOf<protocol.TxStatus>();
  });
});
