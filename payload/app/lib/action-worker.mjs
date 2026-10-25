import { pathToFileURL } from "node:url";
import path from "node:path";
import { initialize, pluginRoot, save } from "./state.mjs";

const action = process.argv[2];
const load = (file) => import(pathToFileURL(path.join(pluginRoot, file)).href);
try {
  const state = await initialize(process.env.KIRO_INTERNAL_DATA_DIR);
  if (action === "models") {
    const { discoverHttpModels } = await load("server/http.mjs");
    const { loadKiroAuth } = await load("server/auth.mjs");
    const { kiroCatalogAccountId } = await load("server/model-catalog.mjs");
    const signal = AbortSignal.timeout(60000);
    const auth = await loadKiroAuth({ authFile: state.authFile, signal });
    const models = await discoverHttpModels({ signal, authProvider: async () => auth });
    if (!models.length)
      throw new Error("Kiro returned an empty catalog; previous metadata was not replaced.");
    const { modelRows } = await import("./state.mjs");
    modelRows(models);
    await save(path.join(state.root, "models.json"), {
      version: 1,
      fetchedAt: new Date().toISOString(),
      accountId: kiroCatalogAccountId(auth),
      models,
    });
    console.log(
      `Account model catalog refreshed: ${models.length} models. No generation request sent.`,
    );
  } else if (action === "usage") {
    const { fetchKiroUsage } = await load("server/usage.mjs");
    console.log(
      JSON.stringify(await fetchKiroUsage({ signal: AbortSignal.timeout(30000) }), null, 2),
    );
  } else throw new Error("Unknown metadata action.");
} catch (error) {
  console.error(`Kiro ${action} failed: ${error.message}`);
  process.exitCode = error.name === "AbortError" ? 130 : 1;
}
