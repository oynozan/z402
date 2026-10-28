// Prints one ready line on stdout and logs only to stderr, so scripts can wait for the line
import { loadDotEnv, loadServiceEnv, runMain, serve } from "@z402/service-kit";
import { loadMarkdownConfig } from "./config.js";
import { createMarkdownService } from "./service.js";

runMain("markdown", async () => {
  loadDotEnv(new URL("../.env", import.meta.url));
  const env = loadServiceEnv(process.env, { port: 4032 });
  const config = loadMarkdownConfig(process.env);
  const service = await createMarkdownService({ env, config });
  const listening = await serve(service.app, env).catch(async (e: unknown) => {
    await service.close();
    throw e;
  });
  return {
    readyLine: `listening on ${listening.url} network=${env.network}`,
    close: async () => {
      await listening.close();
      await service.close();
    },
  };
});
