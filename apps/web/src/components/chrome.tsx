import Link from "next/link";
import { textOf } from "@/lib/format";
import { NavCta, NavLinks } from "./nav-links";

function repoUrl(): string | null {
  const url = textOf(process.env.NEXT_PUBLIC_REPO_URL);
  return url !== null && /^https?:\/\//.test(url) ? url : null;
}

export function Wordmark() {
  return (
    <Link href="/" className="wordmark" aria-label="z402 home">
      z402
    </Link>
  );
}

function Links() {
  return <NavLinks repo={repoUrl()} />;
}

export function Header() {
  return (
    <header className="band nav">
      <div className="frame nav-frame">
        <Wordmark />
        <nav className="nav-links" aria-label="Main">
          <Links />
        </nav>
        <div className="nav-cta">
          <NavCta />
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="band foot">
      <div className="frame foot-frame">
        <div className="foot-brand">
          <Wordmark />
          <p>Shielded x402 payments for AI agents.</p>
        </div>
        <nav className="foot-links" aria-label="Footer">
          <Links />
        </nav>
      </div>
    </footer>
  );
}

export function Chip({ index, label }: { index?: string; label: string }) {
  return (
    <p className="chip">
      {index !== undefined && <span>{index}</span>}
      <span>{label}</span>
    </p>
  );
}

/** The two row checkerboard that opens every band below the hero */
export function Seam() {
  return <div className="wall" aria-hidden="true" />;
}
