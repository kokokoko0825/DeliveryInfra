import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.{js,mjs,cjs,ts,tsx}'], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  prettier,
);
