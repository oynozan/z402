const K = ({ children }: { children: string }) => <span className="t-key">{children}</span>;
const F = ({ children }: { children: string }) => <span className="t-fn">{children}</span>;
const I = ({ children }: { children: string }) => <span className="t-id">{children}</span>;
const S = ({ children }: { children: string }) => <span className="t-str">{children}</span>;
const P = ({ children }: { children: string }) => <span className="t-punc">{children}</span>;

/** The stock x402 fetch client, with the one line that adds Zcash marked */
export function AgentCode() {
  return (
    <figure className="code">
      <figcaption className="code-bar">
        <i />
        <i />
        <i />
        <span>agent.ts</span>
      </figcaption>
      <pre>
        <code>
          <span className="ln">
            <K>import</K> <P>{"{"}</P> <I>x402Client</I>
            <P>,</P> <I>wrapFetchWithPayment</I> <P>{"}"}</P> <K>from</K> <S>&quot;@x402/fetch&quot;</S>
            <P>;</P>
          </span>
          <span className="ln"> </span>
          <span className="ln">
            <K>const</K> <I>client</I> <P>=</P> <K>new</K> <F>x402Client</F>
            <P>();</P>
          </span>
          <span className="ln ln-mark">
            <I>client</I>
            <P>.</P>
            <F>register</F>
            <P>(</P>
            <S>&quot;zcash:mainnet&quot;</S>
            <P>,</P> <I>zcashClientScheme</I>
            <P>);</P>
          </span>
          <span className="ln">
            <K>const</K> <I>paidFetch</I> <P>=</P> <F>wrapFetchWithPayment</F>
            <P>(</P>
            <I>fetch</I>
            <P>,</P> <I>client</I>
            <P>);</P>
          </span>
          <span className="ln">
            <K>await</K> <F>paidFetch</F>
            <P>(</P>
            <S>&quot;https://llm.example/v1/generate&quot;</S>
            <P>);</P>
          </span>
        </code>
      </pre>
    </figure>
  );
}
