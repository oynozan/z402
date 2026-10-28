"use client";

import { CopyCell } from "@/components/copy-cell";
import { Tip } from "@/components/tip";
import { DASH, formatCount, formatZat } from "@/lib/format";
import { summarize, type Health, type RouteRow, type ServiceRow } from "@/lib/services";
import { useBoard } from "./discovery-provider";

const HEALTH_LABEL: Record<Exclude<Health, "unknown">, string> = { up: "Up", starting: "Starting", down: "Down" };

const QUIET = {
  unreachable: "Discovery is not reachable.",
  empty: "No services yet.",
} as const;

function Status({ health }: { health: Health }) {
  return (
    <span className="status" data-health={health}>
      <i aria-hidden="true" />
      {health === "unknown" ? (
        <>
          <span aria-hidden="true">{DASH}</span>
          <span className="sr-only">Unknown</span>
        </>
      ) : (
        HEALTH_LABEL[health]
      )}
    </span>
  );
}

function About({ service }: { service: ServiceRow }) {
  const lines = [...new Set(service.routes.map((r) => r.description).filter((d): d is string => d !== null))];
  if (lines.length === 0 && service.notes.length === 0) return null;
  return (
    <Tip label={`About ${service.name}`}>
      {lines.map((line) => (
        <span className="tip-line" key={line}>
          {line}
        </span>
      ))}
      {service.notes.map((note) => (
        <span className="tip-line tip-note" key={note}>
          {note}
        </span>
      ))}
    </Tip>
  );
}

function RouteCells({ service, route }: { service: ServiceRow; route: RouteRow | null }) {
  return (
    <>
      <td className="c-endpoint" data-label="Endpoint">
        {route === null ? (
          DASH
        ) : (
          <span className="endpoint">
            <span className="verb">{route.method}</span>
            <span className="path">{route.path}</span>
          </span>
        )}
      </td>
      <td className="c-price" data-label="Price">
        {formatZat(route?.priceZat ?? service.priceZat)}
      </td>
      <td className="c-per" data-label="Per">
        {route?.unit ?? service.unit ?? DASH}
      </td>
    </>
  );
}

function ServiceGroup({ service, compact }: { service: ServiceRow; compact: boolean }) {
  const routes: (RouteRow | null)[] = service.routes.length > 0 ? service.routes : [null];
  return (
    <tbody className="svc-group">
      {routes.map((route, i) => (
        <tr key={route === null ? "none" : `${route.method} ${route.url}`} className={i > 0 ? "sub" : undefined}>
          <td className="c-name">
            {i === 0 && (
              <span className="name">
                <span className="name-text">{service.name}</span>
                <About service={service} />
              </span>
            )}
          </td>
          <RouteCells service={service} route={route} />
          <td className="c-status" data-label={i === 0 && !compact ? "Status" : undefined}>
            {i === 0 && <Status health={service.health} />}
          </td>
          {!compact && (
            <>
              <td className="c-today" data-label={i === 0 ? "Today" : undefined}>
                {i === 0 ? formatCount(service.callsToday) : null}
              </td>
              <td className="c-copy">
                {route !== null && <CopyCell text={route.url} label={`${route.method} ${route.url}`} />}
              </td>
            </>
          )}
        </tr>
      ))}
    </tbody>
  );
}

export function ServicesTable({ compact = false }: { compact?: boolean }) {
  const board = useBoard();
  const columns = compact ? 5 : 7;
  return (
    <div className="svc-wrap">
      <table className="svc" data-compact={compact || undefined}>
        <caption className="sr-only">Paid services with their live status</caption>
        <colgroup>
          <col className="w-name" />
          <col className="w-endpoint" />
          <col className="w-price" />
          <col className="w-per" />
          <col className="w-status" />
          {!compact && (
            <>
              <col className="w-today" />
              <col className="w-copy" />
            </>
          )}
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Endpoint</th>
            <th scope="col">Price</th>
            <th scope="col">Per</th>
            <th scope="col">Status</th>
            {!compact && (
              <>
                <th scope="col">Today</th>
                <th scope="col">
                  <span className="sr-only">Copy</span>
                </th>
              </>
            )}
          </tr>
        </thead>
        {board.state === "ready" ? (
          board.services.map((service) => <ServiceGroup key={service.key} service={service} compact={compact} />)
        ) : (
          <tbody className="svc-group">
            <tr>
              <td className="svc-quiet" colSpan={columns}>
                {QUIET[board.state]}
              </td>
            </tr>
          </tbody>
        )}
      </table>
    </div>
  );
}

export function LiveCount() {
  const board = useBoard();
  if (board.state !== "ready") return <p className="count" />;
  const { services, up } = summarize(board);
  return (
    <p className="count">
      <span>
        {services} {services === 1 ? "service" : "services"}
      </span>
      <span className="count-up">
        <i aria-hidden="true" />
        {up} up
      </span>
    </p>
  );
}
