const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i;

function first(value: string | null): string | null {
  const head = value?.split(",")[0]?.trim();
  return head === undefined || head === "" ? null : head;
}

/** The origin the visitor used, from the forwarding headers a proxy sets or else from Host */
export function siteOrigin(header: (name: string) => string | null): string {
  const proto = first(header("x-forwarded-proto"))?.toLowerCase();
  const scheme = proto === "https" || proto === "http" ? proto : "http";
  const forwarded = first(header("x-forwarded-host"));
  const host = forwarded !== null && HOST_RE.test(forwarded) ? forwarded : first(header("host"));
  return `${scheme}://${host !== null && HOST_RE.test(host) ? host : "localhost:3000"}`;
}
