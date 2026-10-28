/** Why a page cannot be served, as the API names it */
export type PageErrorCode =
  | "invalid_url"
  | "blocked_address"
  | "too_large"
  | "unsupported_content_type"
  | "fetch_failed"
  | "fetch_timeout"
  | "convert_failed";

const STATUS: Readonly<Record<PageErrorCode, number>> = {
  invalid_url: 400,
  blocked_address: 403,
  too_large: 413,
  unsupported_content_type: 415,
  fetch_failed: 502,
  fetch_timeout: 504,
  convert_failed: 502,
};

export interface PageErrorBody {
  error: PageErrorCode;
  upstreamStatus?: number;
}

/**
 * A page refused before payment. The message is for logs and tests only: a client gets the code and, for an upstream
 * error status, that status, so that nothing about the server's own network (such as a resolved address) leaks out.
 */
export class PageError extends Error {
  readonly code: PageErrorCode;
  readonly upstreamStatus: number | undefined;

  constructor(code: PageErrorCode, message: string, o: { upstreamStatus?: number; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = "PageError";
    this.code = code;
    this.upstreamStatus = o.upstreamStatus;
  }

  get status(): number {
    return STATUS[this.code];
  }

  body(): PageErrorBody {
    return { error: this.code, ...(this.upstreamStatus !== undefined && { upstreamStatus: this.upstreamStatus }) };
  }
}
