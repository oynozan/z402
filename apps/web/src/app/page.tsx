import { headers } from "next/headers";
import { Suspense } from "react";
import { Badge } from "@/components/chrome";
import { CommandBox } from "@/components/command-box";
import { GetStarted } from "@/components/get-started";
import { HeroVeil } from "@/components/hero-veil";
import { HowItWorks } from "@/components/how-it-works";
import { Catalog } from "@/components/live/catalog";
import { DiscoveryProvider } from "@/components/live/discovery-provider";
import { ServicesRays } from "@/components/services-rays";
import { loadDiscovery } from "@/lib/discovery";
import { siteOrigin } from "@/lib/origin";

async function LiveCatalog() {
  const [snapshot, requestHeaders] = await Promise.all([loadDiscovery(), headers()]);
  return (
    <DiscoveryProvider initial={snapshot}>
      <Catalog origin={siteOrigin((name) => requestHeaders.get(name))} />
    </DiscoveryProvider>
  );
}

export default function Home() {
  return (
    <>
      <section className="section">
        <div className="frame hero">
          <div className="hero-copy">
            <div>
              <h1 className="hero-title rise rise-1">
                Private payments
                <br />
                for AI agents.
              </h1>
              <p className="hero-sub rise rise-2">
                Agents pay for APIs in shielded Zcash: one deposit, then a signed voucher per call.
              </p>
            </div>
            <div className="rise rise-3">
              <CommandBox label="Install" command="npm install @z402-net/client">
                <span className="tk-orange">npm</span> install <span className="tk-green">@z402-net/client</span>
              </CommandBox>
            </div>
          </div>
          <div className="hero-media">
            <HeroVeil />
          </div>
        </div>
      </section>

      <HowItWorks />

      <section className="section" id="services" aria-labelledby="services-title">
        <div className="frame">
          <div className="head head-rays">
            <ServicesRays />
            <div className="head-main">
              <Badge index="03" label="Services" />
              <h2 className="title" id="services-title">
                <span className="title-lead">Live services.</span> Each one priced per call.
              </h2>
            </div>
            <div className="head-cell" />
            <div className="head-cell">
              <p className="lede">
                Every row is a paid API that answers 402 with its terms. Agents read the same list from the
                facilitator&apos;s Bazaar.
              </p>
            </div>
          </div>
          <Suspense fallback={<div className="catalog-pending" />}>
            <LiveCatalog />
          </Suspense>
        </div>
      </section>

      <GetStarted />
    </>
  );
}
