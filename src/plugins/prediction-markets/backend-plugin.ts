import type { GloomPlugin } from "../../types/plugin";
import {
  attachPredictionMarketsPersistence,
  resetPredictionMarketsPersistence,
} from "./services/fetch";

export const predictionMarketsBackendPlugin: GloomPlugin = {
  id: "prediction-markets",
  name: "Prediction Markets",
  version: "1.0.0",
  description: "Browse prediction markets (Polymarket and Kalshi).",
  toggleable: true,
  setup(ctx) {
    attachPredictionMarketsPersistence(ctx.persistence);
  },
  dispose() {
    resetPredictionMarketsPersistence();
  },
};
