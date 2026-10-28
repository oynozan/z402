import Link from "next/link";
import type { CSSProperties } from "react";
import { MARK_PATH_15 } from "@/lib/mark";
import { repoUrl } from "@/lib/repo";
import { MenuToggle, NavLink, type NavItem } from "./nav";

const HOW: NavItem = { href: "/#how", label: "How it works" };
const SERVICES: NavItem = { href: "/services", label: "Services" };
const DOCS: NavItem = { href: "/docs", label: "Docs" };
const QUICKSTART: NavItem = { href: "/docs/quickstart", label: "Quickstart" };
const START: NavItem = { href: "/#start", label: "Get started" };

function repoItem(): NavItem | null {
  const url = repoUrl();
  return url === null ? null : { href: url, label: "GitHub", external: true };
}

export function Wordmark() {
  return <span className="wordmark">z402</span>;
}

/** The z402 mark at the wordmark's size, in the text color it is given */
export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 15 15" aria-hidden="true" focusable="false">
      <path d={MARK_PATH_15} fill="currentColor" />
    </svg>
  );
}

/** pay.sh's section badge, the number, a tick, then the name */
export function Badge({ index, label }: { index?: string; label: string }) {
  return (
    <p className="badge">
      {index !== undefined && (
        <>
          <span className="chip">{index}</span>
          <span className="tick" aria-hidden="true" />
        </>
      )}
      <span className="chip">{label}</span>
    </p>
  );
}

export function Header() {
  const repo = repoItem();
  // Three link cells take three quarters of the row after the wordmark and GET STARTED the last, as on pay.sh. With a
  // repository GitHub takes the place of How it works, which the menu and the footer still list
  const links = repo === null ? [HOW, SERVICES, DOCS] : [SERVICES, DOCS, repo];
  const menu = repo === null ? links : [HOW, SERVICES, DOCS, repo];
  return (
    <header className="section nav">
      <div className="frame nav-bar">
        <Link className="nav-brand" href="/" aria-label="z402 home">
          <Mark />
          <Wordmark />
        </Link>
        <nav className="nav-links" aria-label="Main" style={{ "--links": links.length } as CSSProperties}>
          {links.map((item) => (
            <NavLink key={item.href} item={item} className="nav-link" />
          ))}
        </nav>
        <Link className="nav-cta" href={START.href}>
          {START.label}
        </Link>
        <MenuToggle items={menu} />
      </div>
    </header>
  );
}

/** The docs' quickstart, and the proxy's JSON, which is no page for the router to prefetch */
const DEVELOPERS: NavItem[] = [QUICKSTART, { href: "/discovery/resources", label: "Bazaar list" }];

function FootColumn({ title, items }: { title: string; items: NavItem[] }) {
  return (
    <nav className="foot-col" aria-label={title}>
      <p className="foot-title">{title}</p>
      <ul className="foot-links">
        {items.map((item) => (
          <li key={item.href}>
            {item.href.startsWith("/discovery/") ? (
              <a className="foot-link" href={item.href}>
                {item.label}
              </a>
            ) : (
              <NavLink item={item} className="foot-link" />
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Footer() {
  const repo = repoItem();
  return (
    <footer className="section foot">
      <div className="frame">
        <div className="foot-cols">
          <div className="foot-brand">
            <Link className="foot-mark" href="/" aria-label="z402 home">
              <Wordmark />
            </Link>
            <p className="foot-line">Shielded x402 payments for AI agents.</p>
          </div>
          <FootColumn title="Site" items={[HOW, SERVICES, DOCS, START]} />
          <FootColumn title="Developers" items={repo === null ? DEVELOPERS : [...DEVELOPERS, repo]} />
        </div>
        <div className="foot-tail" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
    </footer>
  );
}
