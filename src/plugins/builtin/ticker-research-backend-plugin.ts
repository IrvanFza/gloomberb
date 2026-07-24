import { attachFredSeriesPersistence } from "../../data/fred-series";
import { composeBuiltinPlugin, type PluginModule } from "./plugin-module";

const chartSeriesPersistenceModule: PluginModule = {
  setup(ctx) {
    attachFredSeriesPersistence(ctx.persistence);
  },
};

export const tickerResearchBackendPlugin = composeBuiltinPlugin({
  id: "ticker-research",
  name: "Ticker Research",
  version: "1.0.0",
  description: "Company research workspace: overview, charts, financials, filings, ownership, options, analyst research, and events.",
  toggleable: true,
  modules: [chartSeriesPersistenceModule],
});
