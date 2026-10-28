"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CopyButton, CopyCell } from "@/components/copy";
import { Tip } from "@/components/tip";
import { curlCommand, exampleBlocks, paidFetchCall } from "@/lib/calls";
import {
  categories,
  filterServices,
  pricedPerRoute,
  priceText,
  slugOf,
  totals,
  unitText,
  type Category,
} from "@/lib/catalog";
import type { RouteTerms } from "@/lib/discovery-types";
import { DASH, formatBps, formatCount, formatCountCompact, formatZat, shortAddress } from "@/lib/format";
import type { Board, Health, RouteRow, ServiceRow } from "@/lib/services";
import { useBoard } from "./discovery-provider";

const BAZAAR_PATH = "/discovery/resources";
const COLUMNS = 8;
/** The filter grid's columns on a wide screen, where one hatched cell fills the last row */
const FILTER_COLUMNS = 6;

const HEALTH: Record<"up" | "stale" | "down", string> = { up: "Up", stale: "Stale", down: "Down" };
/** What a screen reader hears in place of the dash */
const NO_HEALTH: Record<"none" | "unknown", string> = { none: "No heartbeat", unknown: "Unknown" };

const QUIET = {
  unreachable: "The Bazaar is not reachable.",
  empty: "No services yet.",
  none: "No services match.",
} as const;

/** The count, flashing for a moment whenever a poll changes what it shows */
export function LiveCount({ value, compact = false }: { value: number | null; compact?: boolean }) {
  const text = compact ? formatCountCompact(value) : formatCount(value);
  const last = useRef(text);
  const [flashes, setFlashes] = useState(0);
  useEffect(() => {
    if (last.current !== DASH && text !== DASH && text !== last.current) setFlashes((n) => n + 1);
    last.current = text;
  }, [text]);
  // Two names for one animation, so the next change restarts it
  const flash = flashes === 0 ? undefined : flashes % 2 === 0 ? "a" : "b";
  return (
    <span className="live-count" data-flash={flash}>
      {text}
    </span>
  );
}

function Bazaar({ origin }: { origin: string }) {
  const url = `${origin}${BAZAAR_PATH}`;
  return (
    <div className="bazaar">
      <code className="bazaar-cmd">
        <span className="bazaar-verb">GET</span>
        <span className="bazaar-url">
          {origin}
          <wbr />
          {BAZAAR_PATH}
        </span>
      </code>
      <Tip label="About the Bazaar endpoint">
        The facilitator&apos;s Bazaar, passed through this site. Any x402 Bazaar client reads it.
      </Tip>
      <CopyCell text={url} label="the Bazaar endpoint" />
    </div>
  );
}

function Search({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="search">
      <label className="sr-only" htmlFor={id}>
        Search services
      </label>
      <input
        id={id}
        className="search-input"
        type="search"
        placeholder="Search services"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value !== "") {
            e.preventDefault();
            onChange("");
          }
        }}
      />
    </div>
  );
}

function Filters({
  cells,
  total,
  active,
  onPick,
}: {
  cells: Category[];
  total: number;
  active: string | null;
  onPick: (key: string | null) => void;
}) {
  const all: { key: string | null; label: string; count: number }[] = [
    { key: null, label: "All", count: total },
    ...cells.map((c) => ({ key: c.key, label: c.key, count: c.count })),
  ];
  return (
    <div className="filters" role="group" aria-label="Filter by category" data-odd={all.length % 2 === 1 || undefined}>
      {all.map((cell) => (
        <button
          key={cell.key ?? "all"}
          type="button"
          className="filter"
          aria-pressed={active === cell.key}
          onClick={() => onPick(cell.key)}
        >
          <span className="filter-label">{cell.label}</span>
          <span className="filter-count">{cell.count}</span>
        </button>
      ))}
      {all.length % FILTER_COLUMNS !== 0 && <span className="filter filter-fill" aria-hidden="true" />}
    </div>
  );
}

/** The age of the service's latest declaration, a dash for one that never declared or a list that cannot be read */
function Status({ health }: { health: Health }) {
  return (
    <span className="status" data-health={health}>
      <i aria-hidden="true" />
      {health === "none" || health === "unknown" ? (
        <>
          <span aria-hidden="true">{DASH}</span>
          <span className="sr-only">{NO_HEALTH[health]}</span>
        </>
      ) : (
        HEALTH[health]
      )}
    </span>
  );
}

function Endpoint({ routes }: { routes: RouteRow[] }) {
  const [first] = routes;
  if (first === undefined) return <>{DASH}</>;
  if (routes.length > 1) return <span className="endpoint-count">{routes.length} routes</span>;
  return (
    <span className="endpoint">
      <span className="endpoint-verb">{first.method}</span>
      <span className="endpoint-path">{first.path}</span>
    </span>
  );
}

function RouteDetail({ route, copyCall, ownPrice }: { route: RouteRow; copyCall: boolean; ownPrice: boolean }) {
  const name = `${route.method} ${route.path}`;
  const price = formatZat(route.priceZat);
  return (
    <div className="d-grid d-route">
      <section className="d-cell">
        <div className="d-head">
          <h3 className="d-label">About</h3>
          {ownPrice && <p className="d-value">{price === DASH ? DASH : `${price} per call`}</p>}
        </div>
        <p className="d-about">{route.description ?? DASH}</p>
        {route.note !== null && <p className="d-note">{route.note}</p>}
      </section>
      <section className="d-cell">
        <div className="d-head">
          <h3 className="d-label">Request</h3>
          {copyCall && <CopyCell text={paidFetchCall(route)} label={`the paid call to ${name}`} title="Copy call" />}
        </div>
        <p className="d-endpoint">
          <span className="endpoint-verb">{route.method}</span> {route.url}
        </p>
        {exampleBlocks(route.input).map(({ label, code }) => (
          <Fragment key={label}>
            <p className="d-sub">{label}</p>
            <pre className="d-code">{code}</pre>
          </Fragment>
        ))}
        <div className="d-subhead">
          <p className="d-sub">Unpaid, answers 402</p>
          <CopyCell text={curlCommand(route)} label={`the unpaid curl for ${name}`} title="Copy curl" />
        </div>
        <pre className="d-code">{curlCommand(route, { display: true })}</pre>
      </section>
      <section className="d-cell">
        <div className="d-head">
          <h3 className="d-label">Response</h3>
        </div>
        {route.output === null ? <p className="d-about d-quiet">{DASH}</p> : <pre className="d-code">{route.output}</pre>}
      </section>
    </div>
  );
}

function Terms({ service, terms }: { service: ServiceRow; terms: RouteTerms | null }) {
  const price = priceText(service);
  const credit = formatBps(terms?.creditRatioBps ?? null);
  const columns: [string, ReactNode][][] = [
    [
      ["Price", price === DASH ? DASH : `${price} per call`],
      ["Window", formatZat(terms?.windowZat)],
      ["Credit", credit === DASH ? DASH : `${credit} of confirmed`],
      ["Credit cap", formatZat(terms?.creditCapZat)],
    ],
    [
      ["Scheme", terms?.scheme ?? DASH],
      ["Network", terms?.network ?? DASH],
    ],
    [
      [
        "Pay to",
        terms?.payTo == null ? (
          DASH
        ) : (
          <span className="d-payto">
            <code title={terms.payTo}>{shortAddress(terms.payTo)}</code>
            <CopyCell text={terms.payTo} label="the provider's address" />
          </span>
        ),
      ],
    ],
  ];
  return (
    <div className="d-grid" role="group" aria-label="Terms">
      {columns.map((rows, i) => (
        <dl key={i} className="d-cell">
          {rows.map(([label, value]) => (
            <div key={label} className="d-term">
              <dt className="d-label">{label}</dt>
              <dd className="d-value">{value}</dd>
            </div>
          ))}
        </dl>
      ))}
    </div>
  );
}

function Detail({ service, id }: { service: ServiceRow; id: string }) {
  const terms = service.routes.find((r) => r.terms !== null)?.terms ?? null;
  // The row's own COPY CALL already copies the only route's call
  const copyCall = service.routes.length > 1;
  const ownPrice = pricedPerRoute(service);
  return (
    <div className="detail" id={id}>
      {service.routes.map((route) => (
        <RouteDetail key={`${route.method} ${route.url}`} route={route} copyCall={copyCall} ownPrice={ownPrice} />
      ))}
      <Terms service={service} terms={terms} />
    </div>
  );
}

function ServiceRows({
  service,
  open,
  onToggle,
}: {
  service: ServiceRow;
  open: boolean;
  onToggle: () => void;
}) {
  const detailId = useId();
  const [first] = service.routes;
  return (
    <tbody className="svc-group" data-open={open || undefined}>
      <tr className="svc-row" onClick={onToggle}>
        <td className="c-name">
          <button
            type="button"
            className="svc-toggle"
            title={service.name}
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
          >
            <span className="cube">
              <span className="face face-front">
                <span className="face-text">{service.name}</span>
              </span>
              <span className="face face-under" aria-hidden="true">
                <span className="face-text">{slugOf(service)}</span>
              </span>
            </span>
          </button>
        </td>
        <td className="c-cat" data-label="Category">
          <span className="tag">{service.category}</span>
        </td>
        <td className="c-endpoint" data-label="Endpoint">
          <Endpoint routes={service.routes} />
        </td>
        <td className="c-price" data-label="Price">
          {priceText(service)}
        </td>
        <td className="c-per" data-label="Per">
          {unitText(service)}
        </td>
        <td className="c-status" data-label="Status">
          <Status health={service.health} />
        </td>
        <td className="c-today" data-label="Today">
          <LiveCount value={service.callsToday} compact />
        </td>
        <td className="c-copy">
          {first !== undefined && (
            <CopyButton text={paidFetchCall(first)} label={`the paid call to ${service.name}`} className="copy-call">
              Copy call
            </CopyButton>
          )}
        </td>
      </tr>
      {open && (
        <tr className="svc-detail">
          <td colSpan={COLUMNS}>
            <Detail service={service} id={detailId} />
          </td>
        </tr>
      )}
    </tbody>
  );
}

function QuietRow({ text }: { text: string }) {
  return (
    <tbody className="svc-group">
      <tr>
        <td className="svc-quiet" colSpan={COLUMNS}>
          {text}
        </td>
      </tr>
    </tbody>
  );
}

function quietText(board: Board, shown: number): string | null {
  if (board.state !== "ready") return QUIET[board.state];
  return shown === 0 ? QUIET.none : null;
}

/** pay.sh's catalog with rows that open into each route's request, answer and terms, shared by both pages */
export function Catalog({ origin }: { origin: string }) {
  const board = useBoard();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const cells = useMemo(() => categories(board.services), [board.services]);
  // A category that a poll removed stops filtering rather than hiding everything
  const category = picked !== null && cells.some((c) => c.key === picked) ? picked : null;
  const shown = useMemo(() => filterServices(board.services, { category, query }), [board.services, category, query]);
  const quiet = quietText(board, shown.length);

  return (
    <div className="catalog">
      <Bazaar origin={origin} />
      <Search value={query} onChange={setQuery} />
      <Filters cells={cells} total={board.services.length} active={category} onPick={setPicked} />
      <div className="svc-box">
        <table className="svc">
          <caption className="sr-only">Paid services, live</caption>
          <colgroup>
            <col className="col-name" />
            <col className="col-cat" />
            <col className="col-endpoint" />
            <col className="col-price" />
            <col className="col-per" />
            <col className="col-status" />
            <col className="col-today" />
            <col className="col-copy" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col" className="c-cat">
                Category
              </th>
              <th scope="col" className="c-endpoint">
                Endpoint
              </th>
              <th scope="col">Price</th>
              <th scope="col">Per</th>
              <th scope="col">
                <span className="th-tip">
                  Status
                  <Tip label="About the status">
                    From when a service last declared itself: up under 90 s, stale under 10 min, down after. A dash:
                    never declared, listed from its paid calls.
                  </Tip>
                </span>
              </th>
              <th scope="col">Today</th>
              <th scope="col">
                <span className="sr-only">Copy call</span>
              </th>
            </tr>
          </thead>
          {quiet !== null ? (
            <QuietRow text={quiet} />
          ) : (
            shown.map((service) => (
              <ServiceRows
                key={service.key}
                service={service}
                open={open === service.key}
                onToggle={() => setOpen((current) => (current === service.key ? null : service.key))}
              />
            ))
          )}
        </table>
      </div>
    </div>
  );
}

/** The live numbers over the services page, services up of those listed and the calls paid today */
export function LiveTotals() {
  const board = useBoard();
  const { services, up, callsToday } = totals(board.services);
  const ready = board.state === "ready";
  return (
    <>
      <div className="head-cell metric">
        <p className="metric-label">Services up</p>
        <p className="metric-value">
          {ready && up !== null ? (
            <>
              {up}
              <span className="metric-of">/{services}</span>
            </>
          ) : (
            DASH
          )}
        </p>
      </div>
      <div className="head-cell metric">
        <p className="metric-label">Paid calls today</p>
        <p className="metric-value">{ready ? <LiveCount value={callsToday} /> : DASH}</p>
      </div>
    </>
  );
}
