// A minimal structural view of the Inngest step tools — the turn only uses step.run. Typed
// generically so every step.run<T> call site keeps its inferred return type. A step's result is
// memoized by Inngest (JSON round-trip), so a retry replays completed steps instead of re-running
// them — which is what keeps capture, list mutations, reminders and sends exactly-once.
export type TurnStep = { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> }
