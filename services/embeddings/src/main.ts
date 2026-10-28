import { loadDotEnv, loadServiceEnv, runMain, serve } from "@z402/service-kit";
import { loadEmbeddingsConfig } from "./config.js";
import { createEmbeddingsService } from "./service.js";

const PORT = 4033;

runMain("embeddings", async () => {
  loadDotEnv(new URL("../.env", import.meta.url));
  const env = loadServiceEnv(process.env, { port: PORT });
  const config = loadEmbeddingsConfig(process.env);
  const { app } = await createEmbeddingsService({ env, config });
  const listening = await serve(app, { host: env.host, port: env.port });
  // Origin only, so no path or credentials reach the log
  const provider = new URL(config.baseUrl).origin;
  return {
    readyLine: `listening on ${listening.url} network=${env.network} model=${config.model} provider=${provider}`,
    close: listening.close,
  };
});
