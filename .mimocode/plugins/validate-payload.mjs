import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const server = async (ctx) => {
  const validatePath = resolve(ctx.worktree, 'tools/semantic-zoom-tools/scripts/validate.mjs');
  const { validate } = await import(validatePath);

  return {
    "tool.execute.after": async (input, output) => {
      const tool = input.tool.toLowerCase();
      if (tool !== 'write' && tool !== 'edit') return;

      const filePath = input.args?.file_path || input.args?.filePath;
      if (!filePath || !filePath.endsWith('.md')) return;

      let raw;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch {
        return;
      }

      const result = validate(raw);
      if (result.ok) return;

      output.title = `payload validation failed (${result.errors.length} issue(s))`;
      output.output =
        `semantic-zoom payload in ${filePath} failed validation — ` +
        `fix by re-running assemble.mjs with corrected layers.json, never by hand-editing the embedded JSON:\n` +
        result.errors.map((e) => `  - ${e}`).join('\n');
    },
  };
};
