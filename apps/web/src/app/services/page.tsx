import type { Metadata } from "next";
import { headers } from "next/headers";
import { Fragment } from "react";
import { Chip } from "@/components/chrome";
import { CopyCell } from "@/components/copy-cell";
import { DiscoveryProvider } from "@/components/live/discovery-provider";
import { LiveCount, ServicesTable } from "@/components/live/services-table";
import { Tip } from "@/components/tip";
import { loadDiscovery } from "@/lib/discovery";
import { siteOrigin } from "@/lib/origin";

export const metadata: Metadata = { title: "Services" };

const BAZAAR_PATH = "/discovery/resources";

export default async function ServicesPage() {
  const [snapshot, requestHeaders] = await Promise.all([loadDiscovery(), headers()]);
  const origin = siteOrigin((name) => requestHeaders.get(name));
  const endpoint = `${origin}${BAZAAR_PATH}`;
  return (
    <DiscoveryProvider initial={snapshot}>
      <section className="band">
        <div className="frame">
          <div className="head page-head">
            <Chip label="Services" />
            <div className="page-title">
              <h1>Services for agents.</h1>
              <LiveCount />
            </div>
          </div>
          <div className="bazaar">
            <code className="bazaar-cmd">
              <span className="verb">GET</span>
              {/* A narrow row wraps the URL before a path segment, never inside one */}
              <span className="bazaar-url">
                {origin}
                {BAZAAR_PATH.split(/(?=\/)/).map((segment) => (
                  <Fragment key={segment}>
                    <wbr />
                    {segment}
                  </Fragment>
                ))}
              </span>
            </code>
            <Tip label="About this endpoint">
              Any x402 Bazaar client reads this list. Matching happens on the agent&apos;s machine.
            </Tip>
            <CopyCell text={endpoint} label="the Bazaar endpoint" />
          </div>
          <ServicesTable />
        </div>
      </section>
    </DiscoveryProvider>
  );
}
