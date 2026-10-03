/**
 * Per-issue agent parameter resolution: turns `model-<alias>` / `effort-<alias>` label leaf names
 * into a concrete `{ model?, thinking }` using the alias maps from the config.
 */

/**
 * @typedef {object} ParamConfig
 * @property {Record<string, string>} [models] Alias → pi `--model` pattern.
 * @property {Record<string, string>} [efforts] Alias → pi `--thinking` level.
 * @property {string} thinking Fallback thinking level (the global config value).
 *
 * @typedef {object} ResolvedParams
 * @property {true} ok
 * @property {string} [model] Concrete model id, absent when no `model-*` label was present.
 * @property {string} thinking
 * @property {string} [modelAlias]
 * @property {string} [effortAlias]
 *
 * @typedef {object} ResolveError
 * @property {false} ok
 * @property {string} error
 */

/** @type {RegExp} */
const MODEL_RE = /^model-(.+)$/;
/** @type {RegExp} */
const EFFORT_RE = /^effort-(.+)$/;
/** Strips a leading `ai:` / `ai/` group prefix; grouping is cosmetic for us. */
const GROUP_PREFIX_RE = /^ai[:/]/;

/**
 * Resolve the model and thinking level for one issue from its label leaf names.
 *
 * @param {string[] | undefined} labels Leaf label names on the issue.
 * @param {ParamConfig} config
 * @returns {ResolvedParams | ResolveError}
 */
export function resolveAgentParams(labels, config) {
  const leaves = (labels ?? []).map((l) => l.replace(GROUP_PREFIX_RE, ""));
  const modelAliases = leaves
    .map((l) => MODEL_RE.exec(l)?.[1])
    .filter((a) => typeof a === "string");
  const effortAliases = leaves
    .map((l) => EFFORT_RE.exec(l)?.[1])
    .filter((a) => typeof a === "string");

  if (modelAliases.length > 1) {
    return { ok: false, error: `multiple model labels: ${modelAliases.join(", ")}` };
  }
  if (effortAliases.length > 1) {
    return { ok: false, error: `multiple effort labels: ${effortAliases.join(", ")}` };
  }

  const modelAlias = modelAliases[0];
  const effortAlias = effortAliases[0];

  /** @type {Record<string, string>} */
  const models = config.models ?? {};
  /** @type {Record<string, string>} */
  const efforts = config.efforts ?? {};

  /** @type {string | undefined} */
  let model;
  if (modelAlias !== undefined) {
    if (!Object.hasOwn(models, modelAlias)) {
      return { ok: false, error: `unknown model alias "${modelAlias}"` };
    }
    model = models[modelAlias];
  }

  let thinking = config.thinking;
  if (effortAlias !== undefined) {
    if (!Object.hasOwn(efforts, effortAlias)) {
      return { ok: false, error: `unknown effort alias "${effortAlias}"` };
    }
    thinking = efforts[effortAlias];
  }

  return { ok: true, model, thinking, modelAlias, effortAlias };
}
