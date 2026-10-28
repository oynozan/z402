import { Children, isValidElement, type ReactNode } from "react";
import { codeLanguage } from "@/lib/docs/highlight";
import { CodeBody, fenceOf } from "./code";
import { Tabs } from "./tabs";

/**
 * <CodeTabs> around two or more fenced blocks: each fence's title="..." is its tab's label, else its language.
 * The blocks are highlighted here on the server and handed to the tab strip as finished panels.
 */
export function CodeTabs({ children }: { children?: ReactNode }) {
  const labels: string[] = [];
  const codes: (string | null)[] = [];
  const panels: ReactNode[] = [];
  Children.toArray(children).forEach((child, i) => {
    if (!isValidElement<{ title?: unknown; children?: ReactNode }>(child)) return;
    const fence = fenceOf(child.props.children);
    const title = typeof child.props.title === "string" && child.props.title !== "" ? child.props.title : null;
    if (fence === null || fence.lang === "mermaid") {
      labels.push(title ?? `Tab ${i + 1}`);
      codes.push(null);
      panels.push(child);
      return;
    }
    labels.push(title ?? codeLanguage(fence.lang).label);
    codes.push(fence.code);
    panels.push(<CodeBody key={i} code={fence.code} lang={fence.lang} />);
  });
  if (panels.length === 0) return null;
  return <Tabs labels={labels} codes={codes} panels={panels} />;
}
