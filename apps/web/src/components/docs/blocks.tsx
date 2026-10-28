import { existsSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { CopyCell } from "@/components/copy";
import { Tip } from "@/components/tip";
import { textOf } from "@/lib/format";
import { ArrowGlyph, CalloutGlyph, OutGlyph, PlayGlyph, type CalloutKind } from "./glyphs";

/** The custom elements of the docs' MDX contract, which every page uses without importing them */

const isExternal = (href: string) => /^[a-z][a-z\d+.-]*:/i.test(href);

/** The plain text of a node, for an accessible name */
function plain(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plain).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return plain(node.props.children);
  return "";
}

// Callout

const CALLOUT_LABELS: Record<CalloutKind, string> = { note: "Note", tip: "Tip", warning: "Warning", privacy: "Privacy" };

function calloutKind(type: unknown): CalloutKind {
  return typeof type === "string" && type in CALLOUT_LABELS ? (type as CalloutKind) : "note";
}

export function Callout({ type, title, children }: { type?: string; title?: string; children?: ReactNode }) {
  const kind = calloutKind(type);
  const heading = textOf(title);
  return (
    <aside className="callout" data-kind={kind} aria-label={heading ?? CALLOUT_LABELS[kind]}>
      <p className="callout-head">
        <span className="callout-kind">
          <CalloutGlyph kind={kind} />
          {CALLOUT_LABELS[kind]}
        </span>
        {heading !== null && <span className="callout-title">{heading}</span>}
      </p>
      <div className="callout-body">{children}</div>
    </aside>
  );
}

// Steps

export function Steps({ children }: { children?: ReactNode }) {
  return <ol className="steps-list">{children}</ol>;
}

export function Step({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <li className="steps-item">
      {textOf(title) !== null && <p className="steps-title">{title}</p>}
      <div className="steps-body">{children}</div>
    </li>
  );
}

// Cards

export function Cards({ children }: { children?: ReactNode }) {
  const count = Children.toArray(children).filter(isValidElement).length;
  return (
    <div className="cards" data-odd={count % 2 === 1 || undefined}>
      {children}
    </div>
  );
}

export function Card({ title, href, children }: { title?: string; href?: string; children?: ReactNode }) {
  const body = (
    <>
      <span className="card-head">
        <span className="card-title">{title}</span>
        {href !== undefined && (isExternal(href) ? <OutGlyph /> : <ArrowGlyph />)}
      </span>
      {/* A div, since a card's line may come through MDX as a paragraph */}
      {children !== undefined && <div className="card-text">{children}</div>}
    </>
  );
  if (href === undefined) return <div className="card">{body}</div>;
  if (isExternal(href)) {
    return (
      <a className="card" href={href} target="_blank" rel="noreferrer">
        {body}
      </a>
    );
  }
  return (
    <Link className="card" href={href}>
      {body}
    </Link>
  );
}

// Video

/** A path under public/, checked when the page is built; anything else, such as a full URL, is taken as there */
function publicFileExists(src: string): boolean {
  if (!src.startsWith("/") || src.startsWith("//")) return true;
  const publicDir = join(process.cwd(), "public");
  if (!existsSync(publicDir)) return true;
  return existsSync(join(publicDir, decodeURIComponent(src.split(/[?#]/)[0] ?? src)));
}

export function Video({ src, poster, title, caption }: { src: string; poster?: string; title?: string; caption?: string }) {
  const name = textOf(title) ?? "Video";
  const ready = publicFileExists(src);
  const still = poster !== undefined && publicFileExists(poster) ? poster : undefined;
  return (
    <figure className="video">
      <div className="video-bar">
        <span className="code-title" title={name}>
          {name}
        </span>
        {!ready && <span className="video-soon">Recording soon</span>}
      </div>
      {ready ? (
        <video className="video-player" src={src} poster={still} controls playsInline preload="metadata" aria-label={name}>
          <a href={src}>Download the video</a>
        </video>
      ) : (
        <div className="video-pending" role="img" aria-label={`${name}: the recording is coming`}>
          <span className="video-pending-mark">
            <PlayGlyph />
          </span>
        </div>
      )}
      {textOf(caption) !== null && <figcaption className="video-caption">{caption}</figcaption>}
    </figure>
  );
}

// Endpoint

type Auth = "public" | "api-key" | "registration-token";

const AUTH: Record<Auth, { label: string; tip: string }> = {
  public: {
    label: "Public",
    tip: "Open to anyone: no Authorization header needed. On the facilitator, a request that does carry a key which names no provider (unknown or rotated) gets 401.",
  },
  "api-key": {
    label: "API key",
    tip: "Send your provider API key: Authorization: Bearer <key>. Registered providers get a z402_… key from POST /providers; the operator's key is the facilitator's Z402_FACILITATOR_TOKEN.",
  },
  "registration-token": {
    label: "Registration token",
    tip: "Send the operator's registration token as Authorization: Bearer …, when the facilitator sets Z402_REGISTRATION_TOKEN (an empty one counts as unset). Without one the route is open, except on mainnet, where it answers 403 registration_disabled unless Z402_REGISTRATION_OPEN=1.",
  },
};

export function Endpoint({
  method,
  path,
  auth,
  children,
}: {
  method?: string;
  path?: string;
  auth?: string;
  children?: ReactNode;
}) {
  const verb = (textOf(method) ?? "GET").toUpperCase();
  const access = auth !== undefined && auth in AUTH ? AUTH[auth as Auth] : null;
  const route = textOf(path) ?? "/";
  // A long path may break after a slash, a question mark or an ampersand, never inside a word
  const pieces = route.split(/(?<=[/?&])/);
  return (
    <section className="ep" aria-label={`${verb} ${route}`}>
      <div className="ep-bar">
        <span className="ep-method" data-method={verb}>
          {verb}
        </span>
        <code className="ep-path">
          {pieces.map((piece, i) => (
            <Fragment key={i}>
              {i > 0 && <wbr />}
              {piece}
            </Fragment>
          ))}
        </code>
        {access !== null && (
          <span className="ep-auth">
            {access.label}
            <Tip label={`About ${access.label.toLowerCase()} access`}>{access.tip}</Tip>
          </span>
        )}
        <CopyCell text={route} label={`the path ${route}`} />
      </div>
      {children !== undefined && <div className="ep-body">{children}</div>}
    </section>
  );
}

// Params

export function Params({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <div className="params">
      {textOf(title) !== null && <p className="params-title">{title}</p>}
      <dl className="params-list">{children}</dl>
    </div>
  );
}

export function Param({
  name,
  type,
  required,
  children,
}: {
  name?: string;
  type?: string;
  required?: boolean | string;
  children?: ReactNode;
}) {
  const needed = required === true || required === "" || required === "true";
  return (
    <div className="param">
      <dt className="param-head">
        <code className="param-name">{name}</code>
        {textOf(type) !== null && <span className="param-type">{type}</span>}
        {needed && <span className="param-req">Required</span>}
      </dt>
      <dd className="param-body">{children}</dd>
    </div>
  );
}

// Term

export function Term({ tip, children }: { tip?: string; children?: ReactNode }) {
  const word = plain(children).trim();
  if (textOf(tip) === null) return <>{children}</>;
  return (
    <span className="md-term">
      <span className="md-term-word">{children}</span>
      <Tip label={word === "" ? "What this means" : `What ${word} means`}>{tip}</Tip>
    </span>
  );
}

// Source

function repoUrl(): string | null {
  const url = textOf(process.env.NEXT_PUBLIC_REPO_URL);
  return url !== null && /^https?:\/\//.test(url) ? url.replace(/\/+$/, "") : null;
}

/** A file in the repository: a link to it on GitHub when NEXT_PUBLIC_REPO_URL is set, else its path */
export function Source({ path, line, children }: { path?: string; line?: number | string; children?: ReactNode }) {
  const file = (textOf(path) ?? "").replace(/^\.?\/+/, "");
  const label = children ?? file;
  const repo = repoUrl();
  if (repo === null || file === "") return <code className="md-code source">{label}</code>;
  const anchor = line !== undefined && /^\d+(-\d+)?$/.test(String(line)) ? `#L${String(line).replace("-", "-L")}` : "";
  const href = `${repo}/blob/main/${file.split("/").map(encodeURIComponent).join("/")}${anchor}`;
  return (
    <a className="source" href={href} target="_blank" rel="noreferrer">
      <code className="md-code">{label}</code>
      <OutGlyph />
    </a>
  );
}
