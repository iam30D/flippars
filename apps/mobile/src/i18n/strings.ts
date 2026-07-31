// Stable domain copy starts here; this typed catalog is the migration seam for locale bundles.
export const strings = {
  brand: "Flippars",
  informationalOnly: "Informational signals only — no trades are placed.",
  noQualifiedSignal: "No qualified signal",
  noQualifiedSignalBody:
    "The model is abstaining because no prediction passes every confidence and data-quality gate.",
  dataHealth: {
    healthy: "Live data healthy",
    degraded: "Data degraded",
    offline: "Offline",
    connecting: "Connecting",
  },
  outcomes: {
    correct: "Correct",
    incorrect: "Incorrect",
    flat: "Flat",
    void: "Void",
    pending: "Pending",
  },
} as const;
