export { renderCrosshairStrips } from "./raster/crosshair";
export { renderNativeChartBase } from "./raster/price-chart";

export {
  computeBitmapSize,
  computeNativePlacement,
  computeNativePlacements,
  excludeCellRects,
  intersectCellRects,
} from "./raster/placement";

export type {
  CellRect,
  NativeChartBitmap,
  NativePlacement,
} from "./raster/types";
