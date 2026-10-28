import { Badge } from "./chrome";
import { CommandBox } from "./command-box";
import { CopyCell } from "./copy";

const AGENT_SOURCE = `import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { zcashClientScheme } from "./zcash"; // a PrepaidVoucherScheme from @z402-net/client

const client = new x402Client();
client.register("zcash:mainnet", zcashClientScheme);
const paidFetch = wrapFetchWithPayment(fetch, client);

await paidFetch("https://llm.example/v1/generate", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: "Write a haiku about privacy." }),
});
`;

const Key = ({ children }: { children: string }) => <span className="tk-orange">{children}</span>;
const Fn = ({ children }: { children: string }) => <span className="tk-lavender">{children}</span>;
const Str = ({ children }: { children: string }) => <span className="tk-green">{children}</span>;
const Note = ({ children }: { children: string }) => <span className="tk-note">{children}</span>;

/** The stock x402 fetch client, with the two lines that add Zcash marked */
function AgentCode() {
  return (
    <figure className="term">
      <figcaption className="term-bar">
        <span className="term-lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="term-tab">agent.ts</span>
        <CopyCell text={AGENT_SOURCE} label="the agent code" />
      </figcaption>
      <pre className="term-code">
        <code>
          <span className="ln">
            <Key>import</Key> {"{ "}x402Client, wrapFetchWithPayment{" } "}
            <Key>from</Key> <Str>&quot;@x402/fetch&quot;</Str>;
          </span>
          <span className="ln ln-mark">
            <Key>import</Key> {"{ "}zcashClientScheme{" } "}
            <Key>from</Key> <Str>&quot;./zcash&quot;</Str>; <Note>{"// a PrepaidVoucherScheme from @z402-net/client"}</Note>
          </span>
          <span className="ln"> </span>
          <span className="ln">
            <Key>const</Key> client = <Key>new</Key> <Fn>x402Client</Fn>();
          </span>
          <span className="ln ln-mark">
            client.<Fn>register</Fn>(<Str>&quot;zcash:mainnet&quot;</Str>, zcashClientScheme);
          </span>
          <span className="ln">
            <Key>const</Key> paidFetch = <Fn>wrapFetchWithPayment</Fn>(fetch, client);
          </span>
          <span className="ln"> </span>
          <span className="ln">
            <Key>await</Key> <Fn>paidFetch</Fn>(<Str>&quot;https://llm.example/v1/generate&quot;</Str>, {"{"}
          </span>
          <span className="ln">
            {"  "}method: <Str>&quot;POST&quot;</Str>,
          </span>
          <span className="ln">
            {"  "}headers: {"{ "}
            <Str>&quot;content-type&quot;</Str>: <Str>&quot;application/json&quot;</Str>
            {" }"},
          </span>
          <span className="ln">
            {"  "}body: JSON.<Fn>stringify</Fn>({"{ "}prompt: <Str>&quot;Write a haiku about privacy.&quot;</Str>
            {" }"}),
          </span>
          <span className="ln">{"});"}</span>
        </code>
      </pre>
    </figure>
  );
}

export function GetStarted() {
  return (
    <section className="section" id="start" aria-labelledby="start-title">
      <div className="frame">
        <div className="head">
          <div className="head-main">
            <Badge index="04" label="Get started" />
            <h2 className="title" id="start-title">
              <span className="title-lead">Keep the stock x402 client.</span> Register one more scheme.
            </h2>
          </div>
          <div className="head-cell" />
          <div className="head-cell">
            <p className="lede">
              The rest of the agent&apos;s fetch loop does not change. Run the stack to pay the four starter services from
              your own machine.
            </p>
          </div>
        </div>
        <div className="start">
          <div className="start-code">
            <AgentCode />
          </div>
          <div className="start-cmds">
            <CommandBox label="Run the stack" command="docker compose up -d">
              <span className="tk-orange">docker</span> compose up -d
            </CommandBox>
            <CommandBox label="Pay every service" command="docker compose run --rm smoke">
              <span className="tk-orange">docker</span> compose run --rm smoke
            </CommandBox>
          </div>
        </div>
      </div>
    </section>
  );
}
