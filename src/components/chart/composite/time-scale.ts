import type { ResolvedSeries } from "../../../time-series/types";
import type { CompositeTimeScale } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MINIMUM_SLOT_FRACTION = 0.25;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function finiteTimestamp(value: Date): number | null {
  const timestamp = value.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function uniqueSeriesTimestamps(series: ResolvedSeries): number[] {
  return [...new Set(series.points.flatMap((point) => {
    const timestamp = finiteTimestamp(point.date);
    return timestamp === null ? [] : [timestamp];
  }))].sort((left, right) => left - right);
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function sessionDate(timestamp: number, timeZone: string): string {
  try {
    const parts = formatterFor(timeZone).formatToParts(new Date(timestamp));
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Invalid or unsupported IANA zones fall back to UTC below.
  }
  return new Date(timestamp).toISOString().slice(0, 10);
}

function median(values: readonly number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function lowerBoundAnchor(
  anchors: Extract<CompositeTimeScale, { kind: "market" }>["anchors"],
  timestamp: number,
): number {
  let low = 0;
  let high = anchors.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (anchors[middle]!.timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function positionForTimestamp(
  scale: Extract<CompositeTimeScale, { kind: "market" }>,
  timestamp: number,
): number {
  const { anchors, cadenceMs } = scale;
  const index = lowerBoundAnchor(anchors, timestamp);
  const next = anchors[index];
  if (next?.timestamp === timestamp) return next.position;
  const previous = anchors[index - 1];
  if (!previous) {
    return anchors[0]!.position + (timestamp - anchors[0]!.timestamp) / cadenceMs;
  }
  if (!next) {
    const last = anchors.at(-1)!;
    return last.position + (timestamp - last.timestamp) / cadenceMs;
  }
  const elapsed = next.timestamp - previous.timestamp;
  if (elapsed <= 0) return previous.position;
  return previous.position
    + (next.position - previous.position) * ((timestamp - previous.timestamp) / elapsed);
}

export function buildCompositeTimeScale(
  timelineSeries: readonly ResolvedSeries[],
  startTime: number,
  endTime: number,
): CompositeTimeScale {
  const anchorSeries = timelineSeries.find((series) => series.timeBasis?.kind === "market");
  const anchorTimestamps = anchorSeries ? uniqueSeriesTimestamps(anchorSeries) : [];
  if (!anchorSeries?.timeBasis || anchorTimestamps.length === 0) {
    return { kind: "calendar", startTime, endTime };
  }

  const { timeZone } = anchorSeries.timeBasis;
  const sameSessionGaps: number[] = [];
  const allGaps: number[] = [];
  for (let index = 1; index < anchorTimestamps.length; index += 1) {
    const previous = anchorTimestamps[index - 1]!;
    const next = anchorTimestamps[index]!;
    const gap = next - previous;
    if (gap <= 0) continue;
    allGaps.push(gap);
    if (sessionDate(previous, timeZone) === sessionDate(next, timeZone)) {
      sameSessionGaps.push(gap);
    }
  }
  const configuredCadence = anchorSeries.timeBasis.cadenceMs;
  const cadenceMs = typeof configuredCadence === "number"
    && Number.isFinite(configuredCadence)
    && configuredCadence > 0
    ? configuredCadence
    : median(sameSessionGaps) ?? median(allGaps) ?? DAY_MS;

  const anchors: Extract<CompositeTimeScale, { kind: "market" }>["anchors"] = [];
  let position = 0;
  anchorTimestamps.forEach((timestamp, index) => {
    if (index > 0) {
      const previous = anchorTimestamps[index - 1]!;
      const sameSession = sessionDate(previous, timeZone) === sessionDate(timestamp, timeZone);
      position += sameSession
        ? Math.max((timestamp - previous) / cadenceMs, MINIMUM_SLOT_FRACTION)
        : 1;
    }
    anchors.push({ timestamp, position });
  });

  const provisional: Extract<CompositeTimeScale, { kind: "market" }> = {
    kind: "market",
    startTime,
    endTime,
    anchorSeriesId: anchorSeries.id,
    cadenceMs,
    anchors,
    startPosition: 0,
    endPosition: 1,
  };
  const startPosition = positionForTimestamp(provisional, startTime);
  const endPosition = positionForTimestamp(provisional, endTime);
  return {
    ...provisional,
    startPosition,
    endPosition: endPosition > startPosition ? endPosition : startPosition + 1,
  };
}

export function projectCompositeTimestamp(
  scale: CompositeTimeScale,
  timestamp: number,
  placement: "timestamp" | "next-market-slot" = "timestamp",
): { ratio: number; xSlot?: number } | null {
  if (!Number.isFinite(timestamp)) return null;
  if (scale.kind === "calendar") {
    const span = Math.max(scale.endTime - scale.startTime, 1);
    return { ratio: (timestamp - scale.startTime) / span };
  }

  let position: number;
  let xSlot: number | undefined;
  if (placement === "next-market-slot") {
    const index = lowerBoundAnchor(scale.anchors, timestamp);
    const anchor = scale.anchors[index];
    if (!anchor) return null;
    position = anchor.position;
    xSlot = index;
  } else {
    const index = lowerBoundAnchor(scale.anchors, timestamp);
    const exact = scale.anchors[index];
    position = positionForTimestamp(scale, timestamp);
    if (exact?.timestamp === timestamp) xSlot = index;
  }
  const span = Math.max(scale.endPosition - scale.startPosition, Number.EPSILON);
  return { ratio: (position - scale.startPosition) / span, xSlot };
}

export function unprojectCompositeTimestamp(
  scale: CompositeTimeScale,
  ratio: number,
): number {
  const safeRatio = Math.max(0, Math.min(1, ratio));
  if (scale.kind === "calendar") {
    return scale.startTime + (scale.endTime - scale.startTime) * safeRatio;
  }
  const targetPosition = scale.startPosition
    + (scale.endPosition - scale.startPosition) * safeRatio;
  const anchors = scale.anchors;
  let low = 0;
  let high = anchors.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (anchors[middle]!.position < targetPosition) low = middle + 1;
    else high = middle;
  }
  const next = anchors[low];
  const previous = anchors[low - 1];
  if (!previous) {
    return anchors[0]!.timestamp + (targetPosition - anchors[0]!.position) * scale.cadenceMs;
  }
  if (!next) {
    const last = anchors.at(-1)!;
    return last.timestamp + (targetPosition - last.position) * scale.cadenceMs;
  }
  const positionSpan = next.position - previous.position;
  if (positionSpan <= 0) return previous.timestamp;
  return previous.timestamp
    + (next.timestamp - previous.timestamp)
      * ((targetPosition - previous.position) / positionSpan);
}
