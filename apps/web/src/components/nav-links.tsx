"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

function useCurrent(href: string): "page" | undefined {
  return usePathname() === href ? "page" : undefined;
}

/** Services is the solid button beside these links, so it is not repeated among them */
export function NavLinks({ repo }: { repo: string | null }) {
  return (
    <>
      <a href="/#how">How it works</a>
      {repo !== null && (
        <a href={repo} target="_blank" rel="noreferrer">
          GitHub
        </a>
      )}
    </>
  );
}

export function NavCta() {
  return (
    <Link className="btn btn-solid" href="/services" aria-current={useCurrent("/services")}>
      Services
    </Link>
  );
}
