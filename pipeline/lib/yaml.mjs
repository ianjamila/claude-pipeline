// Thin wrapper over the vendored js-yaml so the rest of the pipeline never imports vendor code directly.
import { load, JSON_SCHEMA } from '../vendor/js-yaml.mjs';

// JSON_SCHEMA keeps scalars predictable: dates and yes/no stay strings, so config never changes type silently.
export function parseYaml(text) {
  try {
    return load(text, { schema: JSON_SCHEMA });
  } catch (err) {
    const where = err.mark ? ` at line ${err.mark.line + 1}, column ${err.mark.column + 1}` : '';
    throw new Error(`YAML parse error${where}: ${err.reason || err.message}`);
  }
}
