// What a Codex model id may look like. One tiny module with no imports, shared by buildCodexArgs (the id is spliced into a TOML value,
// so nothing that could escape the quotes) and validateConfig (review.codex_model), which CI vendors: config.mjs must not import codex.mjs.
export const CODEX_MODEL_RE = /^[A-Za-z0-9._-]+$/;
export const CODEX_MODEL_MAX = 100;

export function isCodexModelId(v) {
  return typeof v === 'string' && v.length >= 1 && v.length <= CODEX_MODEL_MAX && CODEX_MODEL_RE.test(v);
}
