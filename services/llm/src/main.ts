// Prints one ready line on stdout and logs only to stderr, so scripts can wait for the line
import { loadDotEnv, loadServiceEnv, runMain, serve } from "@z402-net/service-kit";
import { loadLlmConfig } from "./config.js";
import { createLlmService } from "./service.js";

runMain("llm", async () => {
  loadDotEnv(new URL("../.env", import.meta.url));
  // Per output chunk, unless Z402_PRICE_ZAT sets another price
  const env = loadServiceEnv(process.env, { port: 4031, priceZat: 200n });
  const config = loadLlmConfig(process.env);
  const service = await createLlmService({ env, config });
  const listening = await serve(service.app, env).catch(async (e: unknown) => {
    await service.close();
    throw e;
  });
  return {
    readyLine: `listening on ${listening.url} model=${config.model} network=${env.network}`,
    close: async () => {
      // Stop accepting first, then end the generations so the calls waiting on them answer now
      const stopped = listening.close();
      await service.close();
      await stopped;
    },
  };
});
