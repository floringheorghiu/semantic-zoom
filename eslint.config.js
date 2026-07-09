import tsParser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/engine/**/*.ts', 'src/ui/**/*.ts'],
    languageOptions: { parser: tsParser },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@tauri-apps/*'],
          message: 'engine/ and ui/ must stay Tauri-free for the Phase 2 HTML export (spec §6). Route Tauri access through main.ts / state/.',
        }],
      }],
    },
  },
];
