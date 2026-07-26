import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, type InputRenderable, useNativeRenderer, useUiHost } from "../../../ui";
import { SegmentedControl } from "../../../components";
import {
  Button,
  Checkbox,
  DialogFrame,
  ListView,
  TextField,
  type ListViewItem,
} from "../../../components/ui";
import { NativeSelect } from "../../../components/ui/native-select";
import { type PromptContext, useDialogKeyboard } from "../../../ui/dialog";
import { colors } from "../../../theme/colors";
import type {
  ChartSeriesSpec,
  ChartSpec,
  SeriesAxis,
  PanelScale,
  SeriesPeriod,
  SeriesStyle,
  SeriesTimestampMode,
  SeriesTransform,
} from "../../../time-series/types";
import { isFundamentalFieldId } from "../../../time-series/field-catalog";
import { validateChartSpec } from "../../../time-series/spec";
import { isPlainKey } from "../../../utils/keyboard";
import { getSharedRegistry } from "../../registry";
import {
  canToggleChartSeries,
  MAX_CHART_COMPOSER_SERIES,
  parseChartSpecOr,
} from "./chart-spec";
import {
  appendChartSeries,
  buildEmptyChartPreset,
  applySeriesStyle,
  applySeriesTimestampMode,
  buildSeriesSpec,
  chartSeriesLabel,
  defaultFinancialTimestampMode,
  formatSeriesExpression,
  getCompatibleSeriesStyles,
  getCompatibleSeriesTransforms,
  getSelectedBuiltinStudies,
  getSelectedPairStudies,
  parseSeriesExpression,
  setBuiltinStudies,
  setPairStudies,
} from "./presets";
import type { SeriesCatalogInstrument, SeriesCatalogSuggestion } from "./series-catalog";
import { useSeriesCatalogSuggestions } from "./use-series-catalog";

const AXES: SeriesAxis[] = ["auto", "left", "right"];
const MARKET_PERIODS: SeriesPeriod[] = ["auto", "daily", "weekly", "monthly", "quarterly", "annual"];
const FINANCIAL_PERIODS: SeriesPeriod[] = ["auto", "quarterly", "annual", "ttm"];
const TIMING_OPTIONS: Array<{ value: SeriesTimestampMode; label: string }> = [
  { value: "available-at", label: "Available Date" },
  { value: "period-end", label: "Period End" },
];
type SeriesEditorField =
  | "style"
  | "transform"
  | "axis"
  | "visibility"
  | "panel"
  | "scale"
  | "period"
  | "timing";
type SeriesEditorFocus = "add" | "series" | "source" | SeriesEditorField;

function titleCase(value: string): string {
  return value
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function clampIndex(value: number, length: number): number {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(value, length - 1));
}

function seriesFieldId(series: ChartSeriesSpec): string {
  return series.source.kind === "security" ? series.source.fieldId : series.source.seriesId;
}

function compatiblePeriods(series: ChartSeriesSpec | null): SeriesPeriod[] {
  if (!series || series.source.kind !== "security") return [];
  return series.source.fieldId.startsWith("market.") ? MARKET_PERIODS : FINANCIAL_PERIODS;
}

function supportsTimestampMode(series: ChartSeriesSpec | null): boolean {
  return !!series
    && series.source.kind === "security"
    && isFundamentalFieldId(series.source.fieldId);
}

function seriesTimestampMode(series: ChartSeriesSpec): SeriesTimestampMode {
  return series.source.kind === "security"
    ? series.source.timestampMode
      ?? defaultFinancialTimestampMode(series.source.fieldId)
      ?? "available-at"
    : "available-at";
}

function timingDescription(series: ChartSeriesSpec): string | null {
  if (!supportsTimestampMode(series)) return null;
  return seriesTimestampMode(series) === "available-at" ? "Available date" : "Period end";
}

function DesktopEditorField({
  label,
  children,
  width = "calc(50% - 6px)",
}: {
  label: string;
  children: ReactNode;
  width?: string;
}) {
  return (
    <Box flexDirection="column" width={width} minWidth="220px" style={{ gap: 4 }}>
      <Text fg={colors.textDim} style={{ fontWeight: 600 }}>{label}</Text>
      {children}
    </Box>
  );
}

function TuiEditorField({
  label,
  focused,
  onFocus,
  children,
}: {
  label: string;
  focused: boolean;
  onFocus: () => void;
  children: ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      width="100%"
      overflow="hidden"
      onMouseDown={onFocus}
    >
      <Text fg={focused ? colors.textBright : colors.textDim}>
        {focused ? `› ${label}` : label}
      </Text>
      {children}
    </Box>
  );
}

function pruneSpec(spec: ChartSpec): ChartSpec {
  const selectedBuiltinStudies = getSelectedBuiltinStudies(spec);
  const selectedPairStudies = getSelectedPairStudies(spec);
  const rebound = setPairStudies(
    setBuiltinStudies(spec, selectedBuiltinStudies),
    selectedPairStudies,
  );
  const seriesIds = new Set(rebound.series.map((series) => series.id));
  const studies = rebound.studies.filter((study) => {
    const requiredInputs = study.kind === "ratio" || study.kind === "spread" || study.kind === "correlation" ? 2 : 1;
    return study.inputSeriesIds.length === requiredInputs
      && study.inputSeriesIds.every((id) => seriesIds.has(id));
  });
  const panels = [...rebound.panels];
  if (!panels.some((panel) => panel.id === "main")) panels.unshift({ id: "main" });
  return { ...rebound, panels, studies };
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
  return values.map((entry, entryIndex) => entryIndex === index ? value : entry);
}

function moveAt<T>(values: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= values.length) return [...values];
  const next = [...values];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export interface SeriesEditorDialogProps extends PromptContext<ChartSpec | null> {
  initialSpec: ChartSpec;
}

export function SeriesEditorDialog({ dialogId, resolve, initialSpec }: SeriesEditorDialogProps) {
  const isDesktop = useUiHost().kind === "desktop-web";
  const nativeRenderer = useNativeRenderer();
  const [draft, setDraft] = useState(() => parseChartSpecOr(initialSpec, buildEmptyChartPreset()));
  const [selectedIndex, setSelectedIndex] = useState(() => clampIndex(0, initialSpec.series.length));
  const [expression, setExpression] = useState(() => initialSpec.series[0] ? formatSeriesExpression(initialSpec.series[0]) : "");
  const [editingExpression, setEditingExpression] = useState(false);
  const [quickAddActive, setQuickAddActive] = useState(true);
  const [quickAddQuery, setQuickAddQuery] = useState("");
  const [quickAddSelection, setQuickAddSelection] = useState(0);
  const [keyboardFocus, setKeyboardFocus] = useState<SeriesEditorFocus>("add");
  const [error, setError] = useState<string | null>(null);
  const expressionRef = useRef<InputRenderable | null>(null);
  const quickAddRef = useRef<InputRenderable | null>(null);
  const keyboardFocusRef = useRef<SeriesEditorFocus>("add");
  const catalogCommitLockRef = useRef(false);
  const expressionCommitLockRef = useRef(false);
  const selected = selectedIndex >= 0 ? draft.series[selectedIndex] ?? null : null;
  const keyboardFields = useMemo<SeriesEditorField[]>(() => {
    if (!selected) return [];
    return [
      "style",
      "transform",
      "axis",
      "visibility",
      "panel",
      "scale",
      ...(selected.source.kind === "security" ? ["period" as const] : []),
      ...(supportsTimestampMode(selected) ? ["timing" as const] : []),
    ];
  }, [selected]);
  const keyboardTargets = useMemo<SeriesEditorFocus[]>(() => [
    "add",
    ...(selected ? ["series" as const, "source" as const, ...keyboardFields] : []),
  ], [keyboardFields, selected]);

  const activateQuickAdd = () => {
    setQuickAddActive(true);
  };

  const deactivateQuickAdd = () => {
    setQuickAddActive(false);
  };

  const updateKeyboardFocus = (target: SeriesEditorFocus) => {
    keyboardFocusRef.current = target;
    setKeyboardFocus(target);
  };

  const focusKeyboardTarget = (target: SeriesEditorFocus) => {
    if (!keyboardTargets.includes(target)) return;
    updateKeyboardFocus(target);
    if (target === "add") {
      setEditingExpression(false);
      expressionRef.current?.blur?.();
      activateQuickAdd();
      queueMicrotask(() => quickAddRef.current?.focus?.());
      return;
    }

    deactivateQuickAdd();
    quickAddRef.current?.blur?.();
    if (target === "source") {
      setEditingExpression(true);
      queueMicrotask(() => expressionRef.current?.focus?.());
    } else {
      setEditingExpression(false);
      expressionRef.current?.blur?.();
    }
  };

  const moveKeyboardFocus = (direction: -1 | 1) => {
    const currentIndex = Math.max(0, keyboardTargets.indexOf(keyboardFocusRef.current));
    const nextIndex = (currentIndex + direction + keyboardTargets.length) % keyboardTargets.length;
    const next = keyboardTargets[nextIndex];
    if (next) focusKeyboardTarget(next);
  };

  useEffect(() => {
    const next = selected ? formatSeriesExpression(selected) : "";
    setExpression(next);
    setError(null);
    setEditingExpression(false);
  }, [selected?.id]);

  const defaultInstrument = useMemo<SeriesCatalogInstrument>(() => {
    const firstSecurity = draft.series.find((series) => series.source.kind === "security");
    const security = selected?.source.kind === "security"
      ? selected.source.instrument
      : firstSecurity?.source.kind === "security"
        ? firstSecurity.source.instrument
        : undefined;
    const symbol = security?.symbol ?? "AAPL";
    const saved = getSharedRegistry()?.getTickerFn(symbol);
    return {
      symbol,
      ...(security?.exchange ? { exchange: security.exchange } : saved?.metadata.exchange ? { exchange: saved.metadata.exchange } : {}),
      ...(saved?.metadata.name ? { name: saved.metadata.name } : {}),
    };
  }, [draft.series, selected]);
  const {
    suggestions: quickAddSuggestions,
    loading: quickAddLoading,
  } = useSeriesCatalogSuggestions({
    query: quickAddQuery,
    defaultInstrument,
    enabled: quickAddActive,
  });

  useEffect(() => {
    setQuickAddSelection(0);
  }, [quickAddQuery, quickAddSuggestions.length]);

  useEffect(() => {
    if (!keyboardTargets.includes(keyboardFocus)) updateKeyboardFocus("add");
  }, [keyboardFocus, keyboardTargets]);

  const updateSelected = (update: (series: ChartSeriesSpec) => ChartSeriesSpec) => {
    if (!selected) return;
    setDraft((current) => ({
      ...current,
      series: replaceAt(current.series, selectedIndex, update(current.series[selectedIndex]!)),
    }));
  };

  const commitExpression = (): boolean => {
    if (expressionCommitLockRef.current) return true;
    if (!selected) return false;
    const parsed = parseSeriesExpression(expression);
    if (!parsed) {
      setError("Use SYMBOL, SYMBOL:field, SYMBOL:EXCHANGE:field, or FRED:series.");
      return false;
    }
    expressionCommitLockRef.current = true;
    queueMicrotask(() => {
      expressionCommitLockRef.current = false;
    });

    const candidate = buildSeriesSpec(parsed, selectedIndex);
    const previousFieldId = seriesFieldId(selected);
    const nextFieldId = seriesFieldId(candidate);
    const styles = getCompatibleSeriesStyles(nextFieldId);
    const transforms = getCompatibleSeriesTransforms(nextFieldId);
    const source = candidate.source.kind === "security" && selected.source.kind === "security"
      ? {
        ...candidate.source,
        ...(previousFieldId === nextFieldId
          ? { period: selected.source.period }
          : {}),
        ...(supportsTimestampMode(candidate) && supportsTimestampMode(selected)
          ? { timestampMode: seriesTimestampMode(selected) }
          : {}),
        instrument: candidate.source.instrument.symbol === selected.source.instrument.symbol
          && (candidate.source.instrument.exchange ?? "") === (selected.source.instrument.exchange ?? "")
          ? selected.source.instrument
          : candidate.source.instrument,
      }
      : candidate.source;
    const style = previousFieldId === nextFieldId || styles.includes(selected.style)
      ? selected.style
      : candidate.style;
    const next = applySeriesStyle({
      ...candidate,
      id: selected.id,
      source,
      ...(selected.label ? { label: selected.label } : {}),
      ...(selected.color ? { color: selected.color } : {}),
      ...(selected.visible !== undefined ? { visible: selected.visible } : {}),
      style,
      transform: previousFieldId === nextFieldId || transforms.includes(selected.transform)
        ? selected.transform
        : candidate.transform,
      axis: selected.axis,
      panelId: selected.panelId,
    }, style);
    setDraft((current) => ({ ...current, series: replaceAt(current.series, selectedIndex, next) }));
    setExpression(formatSeriesExpression(next));
    setEditingExpression(false);
    expressionRef.current?.blur?.();
    setError(null);
    return true;
  };

  const clearQuickAddInput = () => {
    setQuickAddQuery("");
    quickAddRef.current?.editBuffer.setText?.("");
    quickAddRef.current?.setCursorOffset?.(0);
  };

  const beginQuickAdd = (reset = false) => {
    if (draft.series.length >= MAX_CHART_COMPOSER_SERIES) {
      setError(`Charts support up to ${MAX_CHART_COMPOSER_SERIES} base series.`);
      return;
    }
    if (reset) clearQuickAddInput();
    updateKeyboardFocus("add");
    setEditingExpression(false);
    activateQuickAdd();
    setError(null);
    quickAddRef.current?.focus?.();
    if (reset) {
      queueMicrotask(() => {
        clearQuickAddInput();
        quickAddRef.current?.focus?.();
      });
    }
  };

  const addCatalogSuggestion = (suggestion: SeriesCatalogSuggestion | undefined) => {
    if (!suggestion || catalogCommitLockRef.current) return;
    if (draft.series.length >= MAX_CHART_COMPOSER_SERIES) {
      setError(`Charts support up to ${MAX_CHART_COMPOSER_SERIES} base series.`);
      return;
    }
    catalogCommitLockRef.current = true;
    queueMicrotask(() => {
      catalogCommitLockRef.current = false;
    });
    const appended = appendChartSeries(draft, suggestion.expression);
    setDraft(appended.spec);
    setSelectedIndex(appended.spec.series.length - 1);
    updateKeyboardFocus("series");
    setExpression(formatSeriesExpression(appended.series));
    clearQuickAddInput();
    deactivateQuickAdd();
    quickAddRef.current?.blur?.();
    setError(null);
  };

  const submitQuickAdd = () => {
    addCatalogSuggestion(quickAddSuggestions[clampIndex(quickAddSelection, quickAddSuggestions.length)]);
  };

  const leaveQuickAdd = () => {
    deactivateQuickAdd();
    quickAddRef.current?.blur?.();
    setError(null);
  };

  const removeSeries = () => {
    if (!selected || draft.series.length <= 1) return;
    setDraft((current) => pruneSpec({
      ...current,
      series: current.series.filter((_, index) => index !== selectedIndex),
    }));
    setSelectedIndex((current) => clampIndex(current, draft.series.length - 1));
    setError(null);
  };

  const moveSeries = (delta: -1 | 1) => {
    if (!selected) return;
    const target = selectedIndex + delta;
    if (target < 0 || target >= draft.series.length) return;
    setDraft((current) => ({ ...current, series: moveAt(current.series, selectedIndex, delta) }));
    setSelectedIndex(target);
  };

  const beginExpressionEdit = () => {
    if (!selected) return;
    updateKeyboardFocus("source");
    deactivateQuickAdd();
    setEditingExpression(true);
    queueMicrotask(() => expressionRef.current?.focus?.());
  };

  const setSelectedPanel = (panelId: string) => {
    if (!selected || !draft.panels.some((panel) => panel.id === panelId)) return;
    updateSelected((series) => ({ ...series, panelId }));
  };

  const addPanel = () => {
    if (!selected) return;
    const used = new Set(draft.panels.map((panel) => panel.id));
    let index = 2;
    while (used.has(`panel-${index}`)) index += 1;
    const id = `panel-${index}`;
    setDraft((current) => ({
      ...current,
      panels: [...current.panels, { id, label: `Panel ${index}`, height: 0.35, scale: "linear" }],
      series: replaceAt(current.series, selectedIndex, { ...current.series[selectedIndex]!, panelId: id }),
    }));
  };

  const cyclePanel = () => {
    if (!selected || draft.panels.length === 0) return;
    const index = draft.panels.findIndex((panel) => panel.id === selected.panelId);
    setSelectedPanel(draft.panels[(index + 1) % draft.panels.length]?.id ?? "main");
  };

  const setSelectedPanelScale = (scale: PanelScale) => {
    if (!selected) return;
    setDraft((current) => ({
      ...current,
      panels: current.panels.map((panel) => panel.id === selected.panelId ? { ...panel, scale } : panel),
      series: scale === "log"
        ? current.series.map((series) => series.panelId === selected.panelId && series.transform === "log"
          ? { ...series, transform: "raw" }
          : series)
        : current.series,
    }));
  };

  const setSelectedTransform = (transform: SeriesTransform) => {
    if (!selected) return;
    setDraft((current) => ({
      ...current,
      panels: transform === "log"
        ? current.panels.map((panel) => panel.id === selected.panelId ? { ...panel, scale: "linear" } : panel)
        : current.panels,
      series: replaceAt(current.series, selectedIndex, (() => {
        const currentSeries = current.series[selectedIndex]!;
        const ohlcStyle = currentSeries.style === "candles" || currentSeries.style === "ohlc" || currentSeries.style === "hlc";
        return {
          ...currentSeries,
          style: transform !== "raw" && ohlcStyle
            ? getCompatibleSeriesStyles(seriesFieldId(currentSeries)).find((style) => style === "line" || style === "area") ?? "line"
            : currentSeries.style,
          transform,
        };
      })()),
    }));
  };

  const setSelectedStyle = (style: SeriesStyle) => {
    updateSelected((series) => applySeriesStyle(series, style));
  };

  const setSelectedTimestampMode = (timestampMode: SeriesTimestampMode) => {
    updateSelected((series) => applySeriesTimestampMode(series, timestampMode));
  };

  const setSelectedVisibility = (visible: boolean) => {
    if (!selected) return;
    setDraft((current) => {
      const target = current.series[selectedIndex];
      if (!target || (!visible && !canToggleChartSeries(current, target.id))) return current;
      return {
        ...current,
        series: replaceAt(current.series, selectedIndex, { ...target, visible }),
      };
    });
  };

  const saveDraft = () => {
    const next = pruneSpec(draft);
    const validation = validateChartSpec(next);
    if (!validation.valid) {
      setError(validation.errors.map((issue) => issue.message).join(" "));
      return;
    }
    resolve(next);
  };

  const toggleSelectedPanelScale = () => {
    const panel = selected ? draft.panels.find((entry) => entry.id === selected.panelId) : null;
    setSelectedPanelScale(panel?.scale === "log" ? "linear" : "log");
  };

  useDialogKeyboard((event) => {
    if (isDesktop && (event.targetEditable === true || event.name === "tab")) {
      if (event.name === "escape") {
        event.stopPropagation();
        event.preventDefault();
        resolve(null);
      }
      return;
    }

    if ((isDesktop && quickAddActive) || (!isDesktop && keyboardFocusRef.current === "add")) {
      const printableSequence = (
        !event.ctrl
        && !event.alt
        && !event.meta
        && !event.super
        && event.sequence
        && [...event.sequence].length === 1
        && event.sequence >= " "
      );
      if (isPlainKey(event, "up")) {
        event.stopPropagation();
        event.preventDefault();
        setQuickAddSelection((current) => clampIndex(current - 1, quickAddSuggestions.length));
      } else if (isPlainKey(event, "down")) {
        event.stopPropagation();
        event.preventDefault();
        setQuickAddSelection((current) => clampIndex(current + 1, quickAddSuggestions.length));
      } else if (event.name === "enter" || event.name === "return") {
        event.stopPropagation();
        event.preventDefault();
        submitQuickAdd();
      } else if (event.name === "escape") {
        event.stopPropagation();
        event.preventDefault();
        resolve(null);
      } else if (event.name === "tab") {
        event.stopPropagation();
        event.preventDefault();
        leaveQuickAdd();
        moveKeyboardFocus(event.shift ? -1 : 1);
      } else if (
        event.targetEditable !== true
        && printableSequence
      ) {
        event.stopPropagation();
        event.preventDefault();
        const nextQuery = `${quickAddRef.current?.editBuffer.getText() ?? quickAddQuery}${event.sequence}`;
        quickAddRef.current?.editBuffer.setText?.(nextQuery);
        quickAddRef.current?.setCursorOffset?.(nextQuery.length);
        setQuickAddQuery(nextQuery);
        activateQuickAdd();
        quickAddRef.current?.focus?.();
      }
      return;
    }

    if ((isDesktop && editingExpression) || (!isDesktop && keyboardFocusRef.current === "source")) {
      if (event.name === "escape") {
        event.stopPropagation();
        event.preventDefault();
        resolve(null);
      } else if (event.name === "enter" || event.name === "return") {
        event.stopPropagation();
        event.preventDefault();
        if (commitExpression()) moveKeyboardFocus(1);
      } else if (event.name === "tab") {
        event.stopPropagation();
        event.preventDefault();
        if (commitExpression()) moveKeyboardFocus(event.shift ? -1 : 1);
      }
      return;
    }

    event.stopPropagation();
    event.preventDefault();
    if (event.name === "tab") {
      moveKeyboardFocus(event.shift ? -1 : 1);
    } else if (keyboardFocusRef.current === "series" && isPlainKey(event, "up", "k")) {
      setSelectedIndex((current) => clampIndex(current - 1, draft.series.length));
    } else if (keyboardFocusRef.current === "series" && isPlainKey(event, "down", "j")) {
      setSelectedIndex((current) => clampIndex(current + 1, draft.series.length));
    } else if (event.name === "[") {
      moveSeries(-1);
    } else if (event.name === "]") {
      moveSeries(1);
    } else if (event.name === "a") {
      beginQuickAdd(true);
    } else if (event.name === "d" || event.name === "delete") {
      removeSeries();
    } else if (event.name === "e") {
      beginExpressionEdit();
    } else if (event.name === "p") {
      cyclePanel();
    } else if (event.name === "n") {
      addPanel();
    } else if (event.name === "l") {
      toggleSelectedPanelScale();
    } else if (event.name === "enter" || event.name === "return") {
      saveDraft();
    } else if (event.name === "escape") {
      resolve(null);
    }
  }, { scope: dialogId, allowEditable: true });

  const items = useMemo<ListViewItem[]>(() => draft.series.map((series) => ({
    id: series.id,
    label: chartSeriesLabel(series),
    description: [
      titleCase(series.style),
      timingDescription(series),
      titleCase(series.transform),
      `${titleCase(series.axis)} axis`,
      series.panelId,
    ].filter(Boolean).join(" · "),
  })), [draft.series]);
  const quickAddItems = useMemo<ListViewItem[]>(() => quickAddSuggestions.map((suggestion) => ({
    id: suggestion.id,
    label: suggestion.label,
    description: suggestion.description,
    detail: suggestion.detail,
  })), [quickAddSuggestions]);
  const fieldId = selected ? seriesFieldId(selected) : "";
  const styleOptions = selected
    ? getCompatibleSeriesStyles(fieldId).map((value) => ({ value, label: titleCase(value) }))
    : [];
  const transformOptions = selected
    ? getCompatibleSeriesTransforms(fieldId).map((value) => ({ value, label: value === "index100" ? "Index 100" : value.toUpperCase() }))
    : [];
  const selectedPanel = selected ? draft.panels.find((panel) => panel.id === selected.panelId) : null;
  const periodOptions = compatiblePeriods(selected);
  const availableTuiWidth = nativeRenderer.terminalWidth > 0
    ? nativeRenderer.terminalWidth - 8
    : 76;
  const tuiContentWidth = Math.max(1, Math.min(76, availableTuiWidth));
  const contentWidth = isDesktop ? "660px" : tuiContentWidth;
  const fieldLabel = (field: SeriesEditorFocus, label: string) => (
    keyboardFocus === field ? `› ${label}` : label
  );

  return (
    <DialogFrame
      title="Chart Series"
      footer={isDesktop
        ? undefined
        : "Tab/Shift+Tab field · ←→ change · ↑↓ series"}
    >
      <Box
        flexDirection="column"
        width={contentWidth}
        overflow="hidden"
        gap={1}
        style={isDesktop ? { gap: 10 } : undefined}
      >
        <TextField
          label={isDesktop ? "Add a series" : fieldLabel("add", "Add a series")}
          value={quickAddQuery}
          placeholder={`Search ${defaultInstrument.symbol} metrics or type “MSFT revenue”`}
          hint={isDesktop ? "Search by ticker or company and metric. Exact FRED IDs also work." : undefined}
          focused={quickAddActive}
          width={isDesktop ? undefined : tuiContentWidth}
          inputRef={quickAddRef}
          onMouseDown={() => beginQuickAdd()}
          onChange={(value) => {
            setQuickAddQuery(value);
            if (value.trim()) {
              activateQuickAdd();
            }
          }}
          onSubmit={submitQuickAdd}
          onBlur={deactivateQuickAdd}
        />

        {quickAddActive && quickAddQuery.trim() && (
          quickAddItems.length > 0 ? (
            <Box width={contentWidth} overflow="hidden" onMouseDown={() => beginQuickAdd()}>
              <ListView
                items={quickAddItems}
                selectedIndex={quickAddSelection}
                height={Math.min(isDesktop ? 5 : 6, quickAddItems.length)}
                surface="framed"
                scrollable={quickAddItems.length > (isDesktop ? 5 : 6)}
                rowGap={isDesktop ? 0 : undefined}
                selectOnHover
                onSelect={setQuickAddSelection}
                onActivate={(_, index) => addCatalogSuggestion(quickAddSuggestions[index])}
              />
            </Box>
          ) : (
            <Text fg={colors.textMuted}>
              {quickAddLoading ? "Searching instruments…" : "No matching security or metric."}
            </Text>
          )
        )}

        {items.length > 0 ? (
          <Box
            width={contentWidth}
            overflow="hidden"
            onMouseDown={() => {
              if (!isDesktop) focusKeyboardTarget("series");
            }}
          >
            <ListView
              items={items}
              selectedIndex={selectedIndex}
              height={isDesktop
                ? Math.min(5, items.length)
                : Math.min(7, Math.max(1, items.length))}
              surface={isDesktop ? "plain" : "framed"}
              selectedBgColor={!isDesktop && keyboardFocus === "series"
                ? colors.borderFocused
                : undefined}
              scrollable={items.length > (isDesktop ? 5 : 7)}
              rowGap={isDesktop ? 0 : undefined}
              selectOnHover={isDesktop}
              onSelect={setSelectedIndex}
              onActivate={(_, index) => {
                setSelectedIndex(index);
              }}
            />
          </Box>
        ) : (
          <Box height={2} justifyContent="center" alignItems="center">
            <Text fg={colors.textMuted}>No series yet. Add one to start the chart.</Text>
          </Box>
        )}

        {selected && (
          <Box flexDirection="column" width="100%" overflow="hidden" gap={1}>
            <TextField
              label={isDesktop
                ? "Exact source (advanced)"
                : fieldLabel("source", "Exact source (advanced)")}
              value={expression}
              placeholder="AAPL:revenue or FRED:CPIAUCSL"
              hint={isDesktop
                ? "Changes this series in place; use an exact symbol, field, or FRED ID."
                : undefined}
              focused={editingExpression}
              width={isDesktop ? undefined : tuiContentWidth}
              inputRef={expressionRef}
              onMouseDown={beginExpressionEdit}
              onKeyDown={(event) => {
                if (event.defaultPrevented) return;
                if (event.name === "escape") {
                  event.stopPropagation();
                  event.preventDefault();
                  resolve(null);
                } else if (event.name === "enter" || event.name === "return") {
                  event.stopPropagation();
                  event.preventDefault();
                  if (commitExpression()) moveKeyboardFocus(1);
                } else if (event.name === "tab") {
                  event.stopPropagation();
                  event.preventDefault();
                  if (commitExpression()) moveKeyboardFocus(event.shift ? -1 : 1);
                }
              }}
              onChange={setExpression}
              onSubmit={() => { commitExpression(); }}
              onBlur={() => {
                if (!editingExpression) return;
                const committed = commitExpression();
                if (!committed && !isDesktop) {
                  updateKeyboardFocus("source");
                  setEditingExpression(true);
                  queueMicrotask(() => expressionRef.current?.focus?.());
                }
              }}
            />

            {isDesktop ? (
              <Box
                flexDirection="row"
                flexWrap="wrap"
                width="100%"
                style={{ columnGap: 12, rowGap: 10 }}
              >
                <DesktopEditorField label="Style">
                  <NativeSelect
                    value={selected.style}
                    options={styleOptions}
                    width="100%"
                    onChange={(value) => setSelectedStyle(value as SeriesStyle)}
                  />
                </DesktopEditorField>
                <DesktopEditorField label="Transform">
                  <NativeSelect
                    value={selected.transform}
                    options={transformOptions}
                    width="100%"
                    onChange={(value) => setSelectedTransform(value as SeriesTransform)}
                  />
                </DesktopEditorField>
                <DesktopEditorField label="Axis">
                  <NativeSelect
                    value={selected.axis}
                    options={AXES.map((value) => ({ value, label: titleCase(value) }))}
                    width="100%"
                    onChange={(value) => updateSelected((series) => ({ ...series, axis: value as SeriesAxis }))}
                  />
                </DesktopEditorField>
                {selected.source.kind === "security" ? (
                  <DesktopEditorField label="Period">
                    <NativeSelect
                      value={selected.source.period ?? "auto"}
                      options={periodOptions.map((value) => ({ value, label: value === "ttm" ? "TTM" : titleCase(value) }))}
                      width="100%"
                      onChange={(value) => updateSelected((series) => series.source.kind === "security" ? ({
                        ...series,
                        source: { ...series.source, period: value as SeriesPeriod },
                      }) : series)}
                    />
                  </DesktopEditorField>
                ) : (
                  <DesktopEditorField label="Visibility">
                    <Box height="28px" justifyContent="center">
                      <Checkbox
                        label="Show series"
                        checked={selected.visible !== false}
                        variant="desktop"
                        onChange={setSelectedVisibility}
                      />
                    </Box>
                  </DesktopEditorField>
                )}
                {supportsTimestampMode(selected) && (
                  <DesktopEditorField label="Timing">
                    <NativeSelect
                      value={seriesTimestampMode(selected)}
                      options={TIMING_OPTIONS}
                      width="100%"
                      onChange={(value) => setSelectedTimestampMode(value as SeriesTimestampMode)}
                    />
                  </DesktopEditorField>
                )}
                <DesktopEditorField label="Panel">
                  <Box flexDirection="row" width="100%" style={{ gap: 6 }}>
                    <Box flexGrow={1} minWidth={0}>
                      <NativeSelect
                        value={selected.panelId}
                        options={draft.panels.map((panel) => ({ value: panel.id, label: panel.label ?? titleCase(panel.id) }))}
                        width="100%"
                        onChange={setSelectedPanel}
                      />
                    </Box>
                    <Button label="New Panel" onPress={addPanel} />
                  </Box>
                </DesktopEditorField>
                <DesktopEditorField label={`Scale (${selectedPanel?.label ?? selected.panelId})`}>
                  <NativeSelect
                    value={selectedPanel?.scale ?? "linear"}
                    options={[
                      { value: "linear", label: "Linear" },
                      { value: "log", label: "Log" },
                    ]}
                    width="100%"
                    onChange={(value) => setSelectedPanelScale(value as PanelScale)}
                  />
                </DesktopEditorField>
                {selected.source.kind === "security" && (
                  <DesktopEditorField label="Visibility" width="100%">
                    <Box height="28px" justifyContent="center">
                      <Checkbox
                        label="Show series"
                        checked={selected.visible !== false}
                        variant="desktop"
                        onChange={setSelectedVisibility}
                      />
                    </Box>
                  </DesktopEditorField>
                )}
              </Box>
            ) : (
              <>
                <TuiEditorField
                  label="Style"
                  focused={keyboardFocus === "style"}
                  onFocus={() => focusKeyboardTarget("style")}
                >
                  <SegmentedControl
                    options={styleOptions}
                    value={selected.style}
                    onChange={(value) => setSelectedStyle(value as SeriesStyle)}
                    focused={keyboardFocus === "style"}
                    shortcutScope={dialogId}
                    width="100%"
                    wrap
                  />
                </TuiEditorField>

                <TuiEditorField
                  label="Transform"
                  focused={keyboardFocus === "transform"}
                  onFocus={() => focusKeyboardTarget("transform")}
                >
                  <SegmentedControl
                    options={transformOptions}
                    value={selected.transform}
                    onChange={(value) => setSelectedTransform(value as SeriesTransform)}
                    focused={keyboardFocus === "transform"}
                    shortcutScope={dialogId}
                    width="100%"
                    wrap
                  />
                </TuiEditorField>

                <TuiEditorField
                  label="Axis"
                  focused={keyboardFocus === "axis"}
                  onFocus={() => focusKeyboardTarget("axis")}
                >
                  <SegmentedControl
                    options={AXES.map((value) => ({ value, label: titleCase(value) }))}
                    value={selected.axis}
                    onChange={(value) => updateSelected((series) => ({ ...series, axis: value as SeriesAxis }))}
                    focused={keyboardFocus === "axis"}
                    shortcutScope={dialogId}
                    width="100%"
                    wrap
                  />
                </TuiEditorField>

                <TuiEditorField
                  label="Visibility"
                  focused={keyboardFocus === "visibility"}
                  onFocus={() => focusKeyboardTarget("visibility")}
                >
                  <SegmentedControl
                    options={[
                      { value: "shown", label: "Shown" },
                      {
                        value: "hidden",
                        label: "Hidden",
                        disabled: selected.visible !== false && !canToggleChartSeries(draft, selected.id),
                      },
                    ]}
                    value={selected.visible === false ? "hidden" : "shown"}
                    onChange={(value) => setSelectedVisibility(value !== "hidden")}
                    focused={keyboardFocus === "visibility"}
                    shortcutScope={dialogId}
                    width="100%"
                    wrap
                  />
                </TuiEditorField>

                <TuiEditorField
                  label="Panel"
                  focused={keyboardFocus === "panel"}
                  onFocus={() => focusKeyboardTarget("panel")}
                >
                  <Box flexDirection="row" width="100%" minWidth={0} gap={1} overflow="hidden">
                    <Box flexGrow={1} minWidth={0} overflow="hidden">
                      <SegmentedControl
                        options={draft.panels.map((panel) => ({ value: panel.id, label: panel.label ?? titleCase(panel.id) }))}
                        value={selected.panelId}
                        onChange={setSelectedPanel}
                        focused={keyboardFocus === "panel"}
                        shortcutScope={dialogId}
                        width="100%"
                        wrap
                      />
                    </Box>
                    <Button label="New Panel" shortcut="N" onPress={addPanel} />
                  </Box>
                </TuiEditorField>

                <TuiEditorField
                  label={`Scale (${selectedPanel?.label ?? selected.panelId})`}
                  focused={keyboardFocus === "scale"}
                  onFocus={() => focusKeyboardTarget("scale")}
                >
                  <SegmentedControl
                    options={[
                      { value: "linear", label: "Linear" },
                      { value: "log", label: "Log" },
                    ]}
                    value={selectedPanel?.scale ?? "linear"}
                    onChange={(value) => setSelectedPanelScale(value as PanelScale)}
                    focused={keyboardFocus === "scale"}
                    shortcutScope={dialogId}
                    width="100%"
                    wrap
                  />
                </TuiEditorField>

                {selected.source.kind === "security" && (
                  <TuiEditorField
                    label="Period"
                    focused={keyboardFocus === "period"}
                    onFocus={() => focusKeyboardTarget("period")}
                  >
                    <SegmentedControl
                      options={periodOptions.map((value) => ({ value, label: value === "ttm" ? "TTM" : titleCase(value) }))}
                      value={selected.source.period ?? "auto"}
                      onChange={(value) => updateSelected((series) => series.source.kind === "security" ? ({
                        ...series,
                        source: { ...series.source, period: value as SeriesPeriod },
                      }) : series)}
                      focused={keyboardFocus === "period"}
                      shortcutScope={dialogId}
                      width="100%"
                      wrap
                    />
                  </TuiEditorField>
                )}

                {supportsTimestampMode(selected) && (
                  <TuiEditorField
                    label="Timing"
                    focused={keyboardFocus === "timing"}
                    onFocus={() => focusKeyboardTarget("timing")}
                  >
                    <SegmentedControl
                      options={TIMING_OPTIONS}
                      value={seriesTimestampMode(selected)}
                      onChange={(value) => setSelectedTimestampMode(value as SeriesTimestampMode)}
                      focused={keyboardFocus === "timing"}
                      shortcutScope={dialogId}
                      width="100%"
                      wrap
                    />
                  </TuiEditorField>
                )}
              </>
            )}
          </Box>
        )}

        {error && <Text fg={colors.negative} wrapText>{error}</Text>}

        <Box flexDirection="row" gap={1} width="100%" style={isDesktop ? { gap: 6, paddingTop: 2 } : undefined}>
          {isDesktop ? (
            <>
              <Box flexDirection="row" style={{ gap: 6 }}>
                <Button label="Add Series" onPress={() => beginQuickAdd(true)} disabled={draft.series.length >= MAX_CHART_COMPOSER_SERIES} />
                <Button label="Remove" variant="danger" onPress={removeSeries} disabled={!selected || draft.series.length <= 1} />
                <Button label="Move Up" onPress={() => moveSeries(-1)} disabled={selectedIndex <= 0} />
                <Button label="Move Down" onPress={() => moveSeries(1)} disabled={selectedIndex < 0 || selectedIndex >= draft.series.length - 1} />
              </Box>
              <Box flexGrow={1} />
              <Box flexDirection="row" style={{ gap: 6 }}>
                <Button label="Cancel" variant="ghost" onPress={() => resolve(null)} />
                <Button label="Save" variant="primary" onPress={saveDraft} />
              </Box>
            </>
          ) : (
            <>
              <Button label="Add Series" shortcut="A" onPress={() => beginQuickAdd(true)} disabled={draft.series.length >= MAX_CHART_COMPOSER_SERIES} />
              <Button label="Remove" shortcut="D" variant="danger" onPress={removeSeries} disabled={!selected || draft.series.length <= 1} />
              <Button label="Move Up" onPress={() => moveSeries(-1)} disabled={selectedIndex <= 0} />
              <Button label="Move Down" onPress={() => moveSeries(1)} disabled={selectedIndex < 0 || selectedIndex >= draft.series.length - 1} />
              <Button label="Cancel" variant="ghost" onPress={() => resolve(null)} />
              <Button label="Save" variant="primary" onPress={saveDraft} />
            </>
          )}
        </Box>
      </Box>
    </DialogFrame>
  );
}
