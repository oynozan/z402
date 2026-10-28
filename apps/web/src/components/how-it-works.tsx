import type { CSSProperties, ReactNode } from "react";
import { Badge } from "./chrome";
import { Replay } from "./replay";
import { Tip } from "./tip";

/** A token of a code line, punctuation as it is, a JSON key or a value */
type Token = string | { k: string } | { v: string };

function Lines({ lines, className = "" }: { lines: Token[][]; className?: string }) {
  return (
    <pre className={`slab pcode ${className}`.trim()}>
      <code>
        {lines.map((line, i) => (
          <span key={i} className="ln" style={{ "--i": i } as CSSProperties}>
            {line.map((token, j) =>
              typeof token === "string" ? (
                token
              ) : "k" in token ? (
                <span key={j} className="tk-key">
                  {token.k}
                </span>
              ) : (
                <span key={j} className="tk-val">
                  {token.v}
                </span>
              ),
            )}
          </span>
        ))}
      </code>
    </pre>
  );
}

const OFFER: Token[][] = [
  ["{"],
  ["  ", { k: '"scheme"' }, ": ", { v: '"prepaid-voucher"' }, ","],
  ["  ", { k: '"network"' }, ": ", { v: '"zcash:mainnet"' }, ","],
  ["  ", { k: '"amount"' }, ": ", { v: '"500"' }, ","],
  ["  ", { k: '"asset"' }, ": ", { v: '"ZEC"' }, ","],
  ["  ", { k: '"extra"' }, ": {"],
  ["    ", { k: '"windowZat"' }, ": ", { v: '"100000"' }, ","],
  ["    ", { k: '"creditRatioBps"' }, ": ", { v: "2500" }],
  ["  }"],
  ["}"],
];

const VOUCHER: Token[][] = [
  ["{"],
  ["  ", { k: '"sessionKey"' }, ": ", { v: '"7c1e…9d"' }, ","],
  ["  ", { k: '"cumulativeZat"' }, ": ", { v: '"1500"' }, ","],
  ["  ", { k: '"sig"' }, ": ", { v: '"e04b…3a"' }],
  ["}"],
];

/** Lines in the demo agent's own format, apps/agent/src/log.ts, once D1 has confirmed and earned its credit */
const CALLS: Token[][] = [
  ["#001 200  ", { v: "c=500" }, "  limit=125,000"],
  ["#002 200  ", { v: "c=1,000" }, "  limit=125,000"],
  ["#003 200  ", { v: "c=1,500" }, "  limit=125,000"],
];

function Strip({ tags, children }: { tags: [string, string]; children?: ReactNode }) {
  return (
    <div className="slab strip">
      <span className="ptags">
        <span className="ptag ptag-key">{tags[0]}</span>
        <span className="ptag">{tags[1]}</span>
      </span>
      {children}
    </div>
  );
}

function Rows({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="prows">
      {rows.map(([term, value], i) => (
        <div key={i} className="prow">
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const hidden = (
  <>
    <span className="redact" aria-hidden="true" />
    <span className="sr-only">hidden</span>
  </>
);

function OfferPanel() {
  return (
    <div className="panel">
      <Strip tags={["402", "llm.example"]} />
      <Lines lines={OFFER} />
    </div>
  );
}

function DepositPanel() {
  return (
    <div className="panel">
      <Strip tags={["D1", "Shielded"]}>
        <span className="pstate">
          <i aria-hidden="true" />
          <span className="pstate-text">
            <span className="pstate-pending" aria-hidden="true">
              Pending
            </span>
            <span className="pstate-confirmed">Confirmed</span>
          </span>
        </span>
      </Strip>
      <div className="slab">
        <p className="psub">With viewing key</p>
        <Rows
          rows={[
            ["Value", "100,000 zat"],
            ["Memo", <code key="memo">&lt;session key&gt;:1</code>],
          ]}
        />
      </div>
      <div className="slab">
        <p className="psub">On chain</p>
        <Rows
          rows={[
            ["Value", hidden],
            ["Memo", hidden],
          ]}
        />
      </div>
    </div>
  );
}

function VoucherPanel() {
  return (
    <div className="panel">
      <Strip tags={["Voucher", "Signed"]} />
      <Lines lines={VOUCHER} />
      <Lines lines={CALLS} className="plog" />
    </div>
  );
}

/** D1 confirmed, D2 pending and a quarter of D1 as credit, with the running total at half the limit */
function CreditPanel() {
  return (
    <div className="panel">
      <Strip tags={["Limit", "225,000 zat"]} />
      <div className="slab">
        <div className="bar" aria-hidden="true">
          <span className="bar-part bar-conf" style={{ flexGrow: 100_000 }} />
          <span className="bar-part bar-pend" style={{ flexGrow: 100_000 }} />
          <span className="bar-part bar-credit" style={{ flexGrow: 25_000 }} />
          <span className="bar-c" style={{ "--at": "50%" } as CSSProperties}>
            <span>c 112,500</span>
          </span>
        </div>
        <Rows
          rows={[
            [<><i className="key key-conf" aria-hidden="true" />Confirmed</>, "100,000"],
            [<><i className="key key-pend" aria-hidden="true" />Pending</>, "100,000"],
            [<><i className="key key-credit" aria-hidden="true" />Credit</>, "25,000"],
          ]}
        />
      </div>
      <div className="slab">
        <p className="psub">
          No second deposit<span className="psub-end">limit 125,000</span>
        </p>
        <p className="prefuse">#251 402  z402_deposit_required</p>
      </div>
    </div>
  );
}

interface Step {
  n: string;
  name: string;
  panel: ReactNode;
  copy: string;
  more: ReactNode;
}

const STEPS: Step[] = [
  {
    n: "01",
    name: "402",
    panel: <OfferPanel />,
    copy: "The API answers 402 with its terms: 500 zat a call, prepaid in 100,000-zat windows (200 calls).",
    more: "Confirmed deposits also earn 25% credit, up to 200,000 zat. The stock x402 client reads all of it from the 402, so there is no account and no API key.",
  },
  {
    n: "02",
    name: "Deposit",
    panel: <DepositPanel />,
    copy: "The agent pays one window, shielded, with its session key in the memo. Nothing on chain shows the amount or the merchant.",
    more: "A viewing key held by the merchant's facilitator reads the deposit. The first call is served on it before it confirms.",
  },
  {
    n: "03",
    name: "Voucher",
    panel: <VoucherPanel />,
    copy: "Each call carries the running total, signed with the session key. The facilitator checks it and the call returns at HTTP speed.",
    more: "No transaction per call: only deposits touch the chain.",
  },
  {
    n: "04",
    name: "Credit",
    panel: <CreditPanel />,
    copy: "The limit is confirmed + pending + 25% credit, and the next deposit leaves before it is reached. An agent that stops depositing is refused at its limit.",
    more: "The next deposit goes out in the background once headroom falls under one window, so the stream never stalls. Unconfirmed money counts for one window at most.",
  },
];

export function HowItWorks() {
  return (
    <section className="section" id="how" aria-labelledby="how-title">
      <div className="frame">
        <div className="head head-half">
          <div className="head-main">
            <Badge index="02" label="How it works" />
            <h2 className="title" id="how-title">
              <span className="title-lead">Pay once on-chain.</span> Then every call is a signed voucher.
            </h2>
          </div>
          <div className="head-cell">
            <p className="lede">Paying on chain for every call would be slow and public. Only deposits touch the chain here, and they are shielded.</p>
          </div>
        </div>
        <Replay steps={STEPS.length}>
          <ol className="steps">
            {STEPS.map((step) => (
              <li key={step.n} className="step">
                <div className="stage">{step.panel}</div>
                <div className="step-text">
                  <div className="step-title">
                    <h3>
                      <span className="step-n">{step.n}</span> {step.name}
                    </h3>
                    <Tip label={`More about step ${step.n}, ${step.name.toLowerCase()}`}>{step.more}</Tip>
                  </div>
                  <p className="step-copy">{step.copy}</p>
                </div>
              </li>
            ))}
          </ol>
        </Replay>
      </div>
    </section>
  );
}
