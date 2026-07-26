import { describe, expect, test } from "bun:test";
import type { TickerRecord } from "../../../types/ticker";
import { resolveEarningsCollectionId, trackedEarningsSymbols } from "./model";

function ticker(
  symbol: string,
  portfolios: string[] = [],
  watchlists: string[] = [],
): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "",
      currency: "USD",
      name: symbol,
      portfolios,
      watchlists,
      positions: [],
      custom: {},
      tags: [],
    },
  };
}

describe("trackedEarningsSymbols", () => {
  test("gives settings-less legacy panes one stable collection scope", () => {
    expect(resolveEarningsCollectionId(undefined, "main")).toBe("main");
    expect(resolveEarningsCollectionId({ collectionId: " watchlist " }, "main")).toBe("watchlist");
    expect(resolveEarningsCollectionId({ collectionId: "" }, "main")).toBe("main");
  });

  test("excludes incidental cached tickers when no collection is focused", () => {
    const tickers = [
      ticker("CACHE"),
      ticker("AAPL", ["main"]),
      ticker("MSFT", [], ["watchlist"]),
      ticker(" aapl ", ["main"], ["watchlist"]),
    ];

    expect(trackedEarningsSymbols(tickers, null)).toEqual(["AAPL", "MSFT"]);
  });

  test("limits symbols to the focused collection when available", () => {
    const tickers = [
      ticker("AAPL", ["main"]),
      ticker("MSFT", ["broker"]),
      ticker("NVDA", [], ["main"]),
    ];

    expect(trackedEarningsSymbols(tickers, "main")).toEqual(["AAPL", "NVDA"]);
  });
});
