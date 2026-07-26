import { createElement, forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ForwardedRef, type ReactNode } from "react";
import {
  computeBitmapSize,
  intersectCellRects,
  type CellRect,
  type NativeChartBitmap,
} from "../../components/chart/native/chart-rasterizer";
import type { ChartRendererPreference } from "../../components/chart/core/types";
import { useResolvedChartRendererState } from "../../components/chart/native/renderer-selection";
import { getNativeSurfaceManager } from "../../components/chart/native/surface/manager";
import {
  getRenderableCellRect,
  resolveNativeSurfaceVisibleRect,
  type NativeSurfaceRenderableNode,
} from "../../components/chart/native/surface/visibility";
import { useOptionalAppSelector, useOptionalPaneInstanceId } from "../../state/app/context";
import { useNativeRenderer, type BoxRenderable, type ChartSurfaceProps } from "../../ui";

interface NativeRenderableNode extends BoxRenderable, NativeSurfaceRenderableNode {
  x: number;
  y: number;
  width: number;
  height: number;
  parent: NativeRenderableNode | null;
  onLifecyclePass: (() => void) | null;
}

interface SurfaceTarget {
  rect: CellRect;
  visibleRect: CellRect | null;
  bitmapKey: string;
}

let nextChartSurfaceId = 1;

function assignRef(ref: ForwardedRef<unknown>, value: unknown) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) {
    (ref as { current: unknown }).current = value;
  }
}

function sameRect(left: CellRect | null, right: CellRect | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function sameTarget(left: SurfaceTarget | null, right: SurfaceTarget | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.bitmapKey === right.bitmapKey
    && sameRect(left.rect, right.rect)
    && sameRect(left.visibleRect, right.visibleRect);
}

// ponytail: identity token instead of hashing every pixel — renderers always
// build a new bitmap object per raster, and hashing megabytes per crosshair
// move was the dominant cost. Mutating a bitmap in place would need a hash.
const bitmapTokens = new WeakMap<NativeChartBitmap, string>();
let nextBitmapToken = 1;

function bitmapKey(bitmap: NativeChartBitmap): string {
  const existing = bitmapTokens.get(bitmap);
  if (existing) return existing;
  const token = `${bitmap.width}x${bitmap.height}:${nextBitmapToken++}`;
  bitmapTokens.set(bitmap, token);
  return token;
}

export const OpenTuiChartSurface = forwardRef<unknown, ChartSurfaceProps>(function OpenTuiChartSurface(
  { children, bitmap, bitmaps, crosshair: _crosshair, nativeBitmapsEnabled = true, ...props },
  forwardedRef,
) {
  const renderer = useNativeRenderer();
  const paneId = useOptionalPaneInstanceId();
  const preferredRenderer = useOptionalAppSelector<ChartRendererPreference>(
    (state) => state.config.chartPreferences.renderer,
    "braille",
  );
  const rendererState = useResolvedChartRendererState(preferredRenderer, renderer);
  const nativeSurfacesEnabled = nativeBitmapsEnabled && rendererState.renderer === "kitty";
  const nativeSurfaceManager = useMemo(() => getNativeSurfaceManager(renderer), [renderer]);
  const surfaceId = useRef(`opentui-chart:${nextChartSurfaceId++}`).current;
  const renderableRef = useRef<NativeRenderableNode | null>(null);
  const [target, setTarget] = useState<SurfaceTarget | null>(null);
  const nativeBitmap = (bitmaps?.[0] ?? bitmap ?? null) as NativeChartBitmap | null;
  const nativeBitmapKey = useMemo(() => (nativeBitmap ? bitmapKey(nativeBitmap) : null), [nativeBitmap]);

  const setRenderableRef = useCallback((node: unknown) => {
    renderableRef.current = node as NativeRenderableNode | null;
    assignRef(forwardedRef, node);
  }, [forwardedRef]);

  useEffect(() => {
    const renderable = renderableRef.current;
    if (!renderable || !nativeBitmap || !nativeBitmapKey || !nativeSurfacesEnabled) {
      setTarget(null);
      return;
    }

    let mountTimer: Timer | null = null;
    const previousLifecyclePass = renderable.onLifecyclePass;
    const syncTarget = () => {
      const rect = getRenderableCellRect(renderable);
      if (!renderer.resolution || renderer.terminalWidth <= 0 || renderer.terminalHeight <= 0) {
        setTarget((current) => (current === null ? current : null));
        return;
      }

      const visibleRect = resolveNativeSurfaceVisibleRect(renderable, renderer.terminalWidth, renderer.terminalHeight);
      const clippedVisibleRect = visibleRect ? intersectCellRects(rect, visibleRect) : null;
      const expectedSize = computeBitmapSize(rect, renderer.resolution, renderer.terminalWidth, renderer.terminalHeight);
      const nextTarget: SurfaceTarget = {
        rect,
        visibleRect: clippedVisibleRect,
        bitmapKey: `${nativeBitmapKey}:${expectedSize.pixelWidth}x${expectedSize.pixelHeight}`,
      };
      setTarget((current) => (sameTarget(current, nextTarget) ? current : nextTarget));
    };
    const lifecyclePass = () => {
      previousLifecyclePass?.();
      syncTarget();
    };

    renderable.onLifecyclePass = lifecyclePass;
    renderer.registerLifecyclePass(renderable);
    syncTarget();
    mountTimer = setTimeout(() => {
      syncTarget();
      renderer.requestRender();
    }, 0);

    return () => {
      if (mountTimer) clearTimeout(mountTimer);
      if (renderable.onLifecyclePass === lifecyclePass) {
        renderable.onLifecyclePass = previousLifecyclePass;
      }
      renderer.unregisterLifecyclePass(renderable);
    };
  }, [nativeBitmap, nativeBitmapKey, nativeSurfacesEnabled, renderer]);

  useEffect(() => {
    return () => {
      nativeSurfaceManager.removeSurface(surfaceId);
    };
  }, [nativeSurfaceManager, surfaceId]);

  useEffect(() => {
    if (!nativeSurfacesEnabled || !target?.visibleRect || !nativeBitmap) {
      nativeSurfaceManager.removeSurface(surfaceId);
      return;
    }

    nativeSurfaceManager.upsertSurface({
      id: surfaceId,
      paneId: paneId ?? "__global__",
      rect: target.rect,
      visibleRect: target.visibleRect,
      bitmap: nativeBitmap,
      bitmapKey: target.bitmapKey,
    });
    renderer.requestRender();
  }, [nativeBitmap, nativeSurfaceManager, nativeSurfacesEnabled, paneId, renderer, surfaceId, target]);

  const showFallback = !nativeSurfacesEnabled || !target || !nativeBitmap;
  return createElement("box" as any, { ...props, ref: setRenderableRef }, showFallback ? children as ReactNode : null);
});
