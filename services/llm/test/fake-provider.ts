/**
 * A scripted OpenAI-compatible provider on a local port: GET /v1/models and POST /v1/chat/completions, which streams
 * the deltas of a script in the event format Ollama sends.
 */
import { serve } from "@z402/service-kit";
import express from "express";

export interface Gate {
  wait: Promise<void>;
  open(): void;
}

/** A step that holds the stream open until it is opened */
export function gate(): Gate {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

export type Step =
  | string
  | Gate
  /** Written as it is */
  | { raw: string }
  /** An error event mid-stream */
  | { error: string }
  /** Destroys the connection */
  | "drop";

export type Reply =
  | {
      steps: Step[];
      /** The finish_reason of the last event, default "stop"; null sends no such event */
      finish?: string | null;
      /** Ends with data: [DONE], default true */
      done?: boolean;
    }
  | { status: number; body: unknown };

export interface ChatBody {
  model?: unknown;
  messages?: unknown;
  max_tokens?: unknown;
  stream?: unknown;
}

export interface FakeProvider {
  /** The API root, ending in /v1 */
  baseUrl: string;
  models: string[];
  reply: (body: ChatBody) => Reply;
  readonly chats: ChatBody[];
  readonly authorizations: (string | undefined)[];
  /** Chat streams the client closed before the end */
  aborted: number;
  close(): Promise<void>;
}

const event = (delta: Record<string, unknown>, finish: string | null): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

export async function fakeProvider(
  o: { models?: string[]; reply?: FakeProvider["reply"] } = {},
): Promise<FakeProvider> {
  const app = express();
  const fake: Omit<FakeProvider, "baseUrl" | "close"> = {
    models: o.models ?? ["test-model"],
    reply: o.reply ?? (() => ({ steps: ["Hello", " there"] })),
    chats: [],
    authorizations: [],
    aborted: 0,
  };

  app.get("/v1/models", (req, res) => {
    fake.authorizations.push(req.get("authorization"));
    const data = fake.models.map((id) => ({ id, object: "model", created: 0, owned_by: "library" }));
    res.json({ object: "list", data });
  });

  app.post("/v1/chat/completions", express.json(), async (req, res) => {
    const body = req.body as ChatBody;
    fake.chats.push(body);
    fake.authorizations.push(req.get("authorization"));
    const reply = fake.reply(body);
    if ("status" in reply) {
      res.status(reply.status).json(reply.body);
      return;
    }
    res.on("close", () => {
      if (!res.writableFinished) fake.aborted += 1;
    });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // Ollama opens with the role and an empty content
    res.write(event({ role: "assistant", content: "" }, null));
    for (const step of reply.steps) {
      if (res.destroyed) return;
      if (step === "drop") {
        // Lets the events written so far reach the client first
        await new Promise((resolve) => setTimeout(resolve, 20));
        res.destroy();
        return;
      }
      if (typeof step === "string") res.write(event({ content: step }, null));
      else if ("wait" in step) await step.wait;
      else if ("raw" in step) res.write(step.raw);
      else res.write(`data: ${JSON.stringify({ error: { message: step.error } })}\n\n`);
    }
    if (res.destroyed) return;
    const finish = reply.finish === undefined ? "stop" : reply.finish;
    if (finish !== null) res.write(event({}, finish));
    if (reply.done !== false) res.write("data: [DONE]\n\n");
    res.end();
  });

  const listening = await serve(app, { host: "127.0.0.1", port: 0 });
  return Object.assign(fake, {
    baseUrl: `${listening.url}/v1`,
    close: async () => {
      listening.server.closeAllConnections();
      await listening.close().catch(() => undefined);
    },
  });
}
