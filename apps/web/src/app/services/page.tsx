import type { Metadata } from "next";
import { headers } from "next/headers";
import { Badge } from "@/components/chrome";
import { Catalog, LiveTotals } from "@/components/live/catalog";
import { DiscoveryProvider } from "@/components/live/discovery-provider";
import { loadDiscovery } from "@/lib/discovery";
import { siteOrigin } from "@/lib/origin";

export const metadata: Metadata = { title: "Services" };

export default async function ServicesPage() {
  const [snapshot, requestHeaders] = await Promise.all([loadDiscovery(), headers()]);
  return (
    <DiscoveryProvider initial={snapshot}>
      <section className="section">
        <div className="frame">
          <div className="head head-page">
            <div className="head-main">
              <Badge label="Services" />
              <h1 className="title title-page">
                <span className="title-lead">Paid APIs for agents.</span> Priced per call, in shielded ZEC.
              </h1>
            </div>
            <LiveTotals />
          </div>
          <Catalog origin={siteOrigin((name) => requestHeaders.get(name))} />
        </div>
      </section>
    </DiscoveryProvider>
  );
}
