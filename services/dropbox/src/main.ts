import { loadDotEnv, loadServiceEnv, runMain, serve } from "@z402-net/service-kit";
import { loadDropboxConfig } from "./config.js";
import { createDropboxService } from "./service.js";

const PORT = 4034;
/** For an upload or a hold alike, each DROPBOX_BLOCKS_PER_CALL blocks, unless Z402_PRICE_ZAT sets another price */
const PRICE_ZAT = 500n;

runMain("dropbox", async () => {
  loadDotEnv(new URL("../.env", import.meta.url));
  const env = loadServiceEnv(process.env, { port: PORT, priceZat: PRICE_ZAT });
  const config = loadDropboxConfig(process.env);
  const service = await createDropboxService({ env, config });
  let listening;
  try {
    listening = await serve(service.app, { host: env.host, port: env.port });
  } catch (e) {
    await service.close();
    throw e;
  }
  const running = listening;
  return {
    readyLine: `listening on ${running.url} network=${env.network} dir=${config.dir}`,
    close: async () => {
      await running.close();
      await service.close();
    },
  };
});
