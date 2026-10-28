import { isValidElement, type ReactNode } from "react";
import { CopyCell } from "@/components/copy";
import { codeLanguage, highlight } from "@/lib/docs/highlight";
import { Mermaid } from "./mermaid";

interface FenceProps {
  className?: string;
  children?: ReactNode;
}

export interface Fence {
  code: string;
  lang: string | null;
}

/** The text and language of a fenced block, from the <code> that MDX puts inside its <pre> */
export function fenceOf(children: ReactNode): Fence | null {
  const child = Array.isArray(children) ? children.find((c) => isValidElement(c)) : children;
  if (!isValidElement<FenceProps>(child)) return null;
  const { className, children: text } = child.props;
  if (typeof text !== "string") return null;
  const lang = /(?:^|\s)language-(\S+)/.exec(className ?? "")?.[1] ?? null;
  // A fence's text ends with the newline before its closing fence
  return { code: text.replace(/\n$/, ""), lang };
}

/** The highlighted lines of a block, the part a tab panel shows on its own */
export async function CodeBody({ code, lang }: Fence) {
  const lines = await highlight(code, lang);
  return (
    <pre className="code-pre" tabIndex={0}>
      <code>
        {lines.map((tokens, i) => (
          <span key={i} className="code-line">
            {tokens.map((token, j) =>
              token.color === undefined ? (
                token.content
              ) : (
                <span key={j} style={{ color: token.color }}>
                  {token.content}
                </span>
              ),
            )}
            {i < lines.length - 1 ? "\n" : null}
          </span>
        ))}
      </code>
    </pre>
  );
}

/** A fenced block: a bar with its title, or else its language, and a copy cell over the highlighted code */
export function CodeBlock({ code, lang, title }: Fence & { title?: string }) {
  const label = title ?? codeLanguage(lang).label;
  return (
    <figure className="code">
      <figcaption className="code-bar">
        <span className="code-title" title={label}>
          {label}
        </span>
        <CopyCell text={code} label={title === undefined ? "the code" : title} />
      </figcaption>
      <CodeBody code={code} lang={lang} />
    </figure>
  );
}

/** MDX's <pre>: a mermaid fence becomes a diagram, any other a code block; rehype-mdx-code-props passes title */
export function Pre({ children, title }: { children?: ReactNode; title?: unknown }) {
  const fence = fenceOf(children);
  if (fence === null) return <pre className="code-pre">{children}</pre>;
  if (fence.lang === "mermaid") return <Mermaid source={fence.code} />;
  return <CodeBlock code={fence.code} lang={fence.lang} title={typeof title === "string" && title !== "" ? title : undefined} />;
}
