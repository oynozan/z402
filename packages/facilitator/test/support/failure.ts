/** The error a call rejects with, failing the test if it resolves */
export async function failure(attempt: Promise<unknown>): Promise<Error> {
  try {
    await attempt;
  } catch (e) {
    if (e instanceof Error) return e;
    throw e;
  }
  throw new Error("expected the call to reject");
}
