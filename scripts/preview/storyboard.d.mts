/**
 * Types for `storyboard.mjs`, which node runs directly and TypeScript cannot read.
 * The shapes are declared here so the unit test can import the real values and still
 * be checked; keep them in step with the JSDoc there.
 */
export interface TourStep {
  readonly label: string;
  /** The key pressed to reach this frame; empty for a surface no key reaches. */
  readonly key: string;
  /** One of `SURFACES[].surface`: the user-visible surface this frame proves. */
  readonly surface: string;
  readonly ms: number;
  readonly topic: string;
  readonly mark: string;
}

export interface Surface {
  readonly surface: string;
  readonly what: string;
}

export declare const TOUR: readonly TourStep[];
export declare const SURFACES: readonly Surface[];
export declare const LEGEND: readonly string[];
export declare const LIMITS: { readonly maxLoopMs: number; readonly maxBytes: number };
