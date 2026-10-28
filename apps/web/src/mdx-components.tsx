import type { MDXComponents } from "mdx/types";
import {
  Callout,
  Card,
  Cards,
  Endpoint,
  Param,
  Params,
  Source,
  Step,
  Steps,
  Term,
  Video,
} from "@/components/docs/blocks";
import { Pre } from "@/components/docs/code";
import { CodeTabs } from "@/components/docs/code-tabs";
import { Anchor, Blockquote, H1, H2, H3, H4, InlineCode, Table } from "@/components/docs/prose";

/** The components every docs page gets without imports, as the MDX contract in apps/web/README.md lists them */
const components = {
  h1: H1,
  h2: H2,
  h3: H3,
  h4: H4,
  a: Anchor,
  code: InlineCode,
  pre: Pre,
  table: Table,
  blockquote: Blockquote,
  Callout,
  Steps,
  Step,
  CodeTabs,
  Cards,
  Card,
  Video,
  Endpoint,
  Params,
  Param,
  Term,
  Source,
} satisfies MDXComponents;

export function useMDXComponents(): MDXComponents {
  return components;
}
