import { loadDotEnv, loadServiceEnv, runMain, serve } from "@z402/service-kit";
import { loadEmbeddingsConfig } from "./config.js";
import { createEmbeddingsService } from "./service.js";

const PORT = 4033;
/** For about 1,000 tokens, unless Z402_PRICE_ZAT sets another price */
const PRICE_ZAT = 100n;

runMain("embeddings", async () => {
  loadDotEnv(new URL("../.env", import.meta.url));
  const env = loadServiceEnv(process.env, { port: PORT, priceZat: PRICE_ZAT });
  const config = loadEmbeddingsConfig(process.env);
  const service = await createEmbeddingsService({ env, config });
  const listening = await serve(service.app, { host: env.host, port: env.port }).catch(async (e: unknown) => {
    await service.close();
    throw e;
  });
  // Origin only, so no path or credentials reach the log
  const provider = new URL(config.baseUrl).origin;
  return {
    readyLine: `listening on ${listening.url} network=${env.network} model=${config.model} provider=${provider}`,
    close: async () => {
      await listening.close();
      await service.close();
    },
  };
});
