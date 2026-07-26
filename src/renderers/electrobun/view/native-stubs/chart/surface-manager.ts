export interface NativePaneLayer {
  paneId: string;
  zIndex: number;
}

export interface NativeOccluder {
  id: string;
  paneId?: string | null;
  rect: { x: number; y: number; width: number; height: number };
  zIndex: number;
}

export interface NativeLocalOccluder {
  id: string;
  paneId: string;
  rect: { x: number; y: number; width: number; height: number };
}

// Must expose every public method of the terminal manager: the desktop view
// bundle swaps this module in, so a missing method is a runtime crash.
// native-stubs.test.ts guards the drift.
export class NativeSurfaceManager {
  setWindowState(): void {}
  upsertSurface(): void {}
  updateSurfaceGeometry(): void {}
  removeSurface(): void {}
  upsertLocalOccluder(): void {}
  removeLocalOccluder(): void {}
  destroy(): void {}
}

const manager = new NativeSurfaceManager();

export function getNativeSurfaceManager(): NativeSurfaceManager {
  return manager;
}
