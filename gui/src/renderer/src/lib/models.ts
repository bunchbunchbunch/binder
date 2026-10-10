// pi's Ctrl+P / Shift+Ctrl+P and Shift+Tab: the step from the session's model
// or effort level to the next, over the host's `models` list. The TUI's
// SessionHost (cycleModel, cycleEffort) takes the same steps.

export type ModelEntry = { value: string; resolvedModel?: string; supportedEffortLevels?: string[] };

const idOf = (m: ModelEntry) => m.resolvedModel ?? m.value;

export function findModel(models: ModelEntry[], model: string | null): ModelEntry | undefined {
  return models.find((m) => m.resolvedModel === model || m.value === model);
}

/** The model `delta` steps on from `model`, wrapping around. A model listed twice (Claude Code's "default" and "opus") counts once. */
export function stepModel(models: ModelEntry[], model: string | null, delta: 1 | -1): ModelEntry | undefined {
  const ids = [...new Set(models.map(idOf))];
  if (!ids.length) return undefined;
  const current = findModel(models, model);
  const i = current ? ids.indexOf(idOf(current)) : -1;
  const id = ids[i < 0 ? (delta > 0 ? 0 : ids.length - 1) : (i + delta + ids.length) % ids.length];
  return models.find((m) => idOf(m) === id);
}

/** The model's next effort level after `effort`, wrapping around; undefined when it has none. */
export function stepEffort(model: ModelEntry | undefined, effort: string | null): string | undefined {
  const levels = model?.supportedEffortLevels ?? [];
  return levels.length ? levels[(levels.indexOf(effort ?? '') + 1) % levels.length] : undefined;
}
