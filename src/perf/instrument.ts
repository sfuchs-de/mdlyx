// Lightweight performance instrumentation (Phase 10).
//
// It counts the operations whose frequency is an architectural *invariant*:
//   - parse / serialize / export must NOT run on ordinary keystrokes
//   - at most one MathLive field is ever live (equations are otherwise static)
// and times key operations via the User Timing API. State is exposed on
// `window.__perf` so e2e tests can assert the invariants directly.

export interface PerfState {
  parseCount: number;
  serializeCount: number;
  exportCount: number;
  activeMathFields: number; // currently live MathLive instances (must stay ≤ 1)
  mathActivations: number; // cumulative activations
  timings: Record<string, number>; // last measured duration per label, in ms
}

const state: PerfState = {
  parseCount: 0,
  serializeCount: 0,
  exportCount: 0,
  activeMathFields: 0,
  mathActivations: 0,
  timings: {},
};

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

// Time a synchronous operation, recording the duration and a User Timing
// measure (visible in devtools / the Performance panel).
export function timed<T>(label: string, fn: () => T): T {
  const t0 = now();
  try {
    return fn();
  } finally {
    const dt = now() - t0;
    state.timings[label] = dt;
    if (typeof performance !== "undefined" && performance.measure) {
      try {
        performance.mark(`${label}:end`);
        performance.measure(label, { start: t0, end: t0 + dt });
      } catch {
        /* User Timing unavailable — ignore */
      }
    }
  }
}

export const perf = {
  state,
  countParse() {
    state.parseCount++;
  },
  countSerialize() {
    state.serializeCount++;
  },
  countExport() {
    state.exportCount++;
  },
  mathActivated() {
    state.activeMathFields++;
    state.mathActivations++;
  },
  mathDeactivated() {
    state.activeMathFields = Math.max(0, state.activeMathFields - 1);
  },
  reset() {
    state.parseCount = 0;
    state.serializeCount = 0;
    state.exportCount = 0;
    state.mathActivations = 0;
    state.timings = {};
  },
};

if (typeof window !== "undefined") {
  (window as unknown as { __perf: typeof perf }).__perf = perf;
}
