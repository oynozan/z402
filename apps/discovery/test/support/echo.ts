/** A real kit-based paid service on the in-process test stack, with a POST route and a GET route with a parameter */
import { createPaidService, onDelivered, type ServiceDefinition, type ServiceEnv } from "@z402/service-kit";
import { startTestStack, type TestStack } from "@z402/service-kit/testing";
import express, { type NextFunction, type Request, type Response } from "express";

/** Refuses an empty body, which is what a discovery probe sends */
const needsText = (req: Request, res: Response, next: NextFunction): void => {
  if (typeof req.body?.text !== "string") {
    res.status(400).json({ error: "text_required" });
    return;
  }
  next();
};

export const DEFINITION: ServiceDefinition = {
  serviceName: "Echo",
  tags: ["test"],
  routes: [
    {
      method: "POST",
      path: "/v1/echo",
      description: "Echoes text back",
      unit: "echo",
      note: "Test note",
      discovery: {
        bodyType: "json",
        input: { text: "hello" },
        inputSchema: { properties: { text: { type: "string" } }, required: ["text"] },
        output: { example: { text: "hello" } },
      },
      prepare: [express.json(), needsText],
    },
    {
      method: "GET",
      path: "/v1/items/:id",
      probePath: "/v1/items/example",
      description: "Reads one item",
      unit: "item",
      discovery: { output: { example: { id: "example" } } },
    },
  ],
};

export function echoStack(o: { ready?: () => boolean } = {}): Promise<TestStack> {
  return startTestStack({
    build: async (env: ServiceEnv) => {
      const { app } = await createPaidService({ env, service: DEFINITION, ready: o.ready });
      app.post("/v1/echo", (req, res) => {
        onDelivered(res, {});
        res.json({ text: req.body.text });
      });
      app.get("/v1/items/:id", (req, res) => {
        res.json({ id: req.params.id });
      });
      return app;
    },
  });
}

export const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
