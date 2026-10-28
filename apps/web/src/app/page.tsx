import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Chip, Seam } from "@/components/chrome";
import { AgentCode } from "@/components/code-panel";
import { HeroVeil } from "@/components/hero-veil";
import { InstallCommand } from "@/components/install-command";
import { DiscoveryProvider } from "@/components/live/discovery-provider";
import { ServicesTable } from "@/components/live/services-table";
import { CreditMotif, DepositMotif, VoucherMotif } from "@/components/motifs";
import { Tip } from "@/components/tip";
import { loadDiscovery } from "@/lib/discovery";

const STEPS: { title: string; motif: ReactNode; body: string; more: string }[] = [
  {
    title: "Deposit",
    motif: <DepositMotif />,
    body: "One shielded deposit funds a window of calls.",
    more: "Its memo ties the deposit to the agent's session key, so a leaked txid credits no one.",
  },
  {
    title: "Voucher",
    motif: <VoucherMotif />,
    body: "Each call carries a signed running total.",
    more: "No transaction per call. The merchant checks the signature and the new total.",
  },
  {
    title: "Credit",
    motif: <CreditMotif />,
    body: "Credit grows from confirmed deposits, so the stream never stalls.",
    more: "A client that stops depositing is refused at its limit.",
  },
];

async function LiveServices() {
  return (
    <DiscoveryProvider initial={await loadDiscovery()}>
      <ServicesTable compact />
    </DiscoveryProvider>
  );
}

export default function Home() {
  return (
    <>
      <section className="band" id="top">
        <div className="frame hero">
          <h1 className="rise rise-1">
            Private payments
            <span>for AI agents.</span>
          </h1>
          <p className="lead rise rise-2">
            Agents pay for APIs in shielded Zcash: one deposit, then a signed voucher per call.
          </p>
          <div className="hero-cta rise rise-3">
            <InstallCommand />
            <Link className="btn btn-lg" href="/services">
              Services
            </Link>
          </div>
          <HeroVeil />
        </div>
      </section>

      <section className="band" id="how">
        <div className="frame">
          <Seam />
          <div className="head">
            <Chip index="01" label="How it works" />
            <h2>One deposit, then vouchers.</h2>
          </div>
          <ol className="steps">
            {STEPS.map((step) => (
              <li key={step.title} className="step">
                {step.motif}
                <div className="step-head">
                  <h3>{step.title}</h3>
                  <Tip label={`More about the ${step.title.toLowerCase()}`}>{step.more}</Tip>
                </div>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="band" id="agent">
        <div className="frame">
          <Seam />
          <div className="agent">
            <div className="agent-copy">
              <h2>One line adds Zcash.</h2>
              <p className="lead">The agent keeps its stock x402 client and registers one more scheme.</p>
            </div>
            <div className="agent-code">
              <AgentCode />
            </div>
          </div>
        </div>
      </section>

      <section className="band" id="services">
        <div className="frame">
          <Seam />
          <div className="head">
            <Chip index="02" label="Services" />
            <h2>Priced per call.</h2>
          </div>
          <Suspense fallback={<div className="svc-wrap svc-pending" />}>
            <LiveServices />
          </Suspense>
          <Link className="more-row" href="/services">
            All services
          </Link>
        </div>
      </section>
    </>
  );
}
