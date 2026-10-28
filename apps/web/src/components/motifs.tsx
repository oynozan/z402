/** As many slots as the widest motif holds, a narrower cell wraps the rest out of sight */
const SLOTS = 36;

const slots = (n: number, className?: string) => Array.from({ length: n }, (_, i) => <i key={i} className={className} />);

/** One shielded deposit, drawn dithered, funds a whole window of calls at once */
export function DepositMotif() {
  return (
    <div className="motif m-deposit" aria-hidden="true">
      <span className="m-coin" />
      <span className="m-link" />
      <span className="m-strip">{slots(SLOTS)}</span>
    </div>
  );
}

/** Each call adds one step to a running total, laid out from the right so the tallest bar always ends the ramp */
export function VoucherMotif() {
  return (
    <div className="motif m-voucher" aria-hidden="true">
      <span className="m-ramp">
        {Array.from({ length: SLOTS }, (_, i) => (
          <i key={i} style={{ height: `${Math.max(8, Math.round(64 - i * 1.6))}px` }} />
        ))}
      </span>
    </div>
  );
}

/** Credit is a quarter of the confirmed deposits, so the limit moves out as they confirm */
const CREDIT_ROWS = [
  { paid: 4, credit: 1 },
  { paid: 8, credit: 2 },
  { paid: 12, credit: 3 },
] as const;

/** Calls run on deposits, then on credit, and every call past the limit is refused */
export function CreditMotif() {
  return (
    <div className="motif m-credit" aria-hidden="true">
      {CREDIT_ROWS.map((row, r) => (
        <span key={r} className={`m-row m-row-${r}`}>
          {slots(row.paid, "paid")}
          {slots(row.credit, "credit")}
          <b />
          {slots(SLOTS - row.paid - row.credit - 1, "refused")}
        </span>
      ))}
    </div>
  );
}
