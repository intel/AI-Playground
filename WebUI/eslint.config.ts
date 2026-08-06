import pluginVue from 'eslint-plugin-vue'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'

// To allow more languages other than `ts` in `.vue` files, uncomment the following lines:
// import { configureVueProject } from '@vue/eslint-config-typescript'
// configureVueProject({ scriptLangs: ['ts', 'tsx'] })
// More info at https://github.com/vuejs/eslint-config-typescript/#advanced-setup

export default defineConfigWithVueTs(
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    name: 'app/files-to-lint',
    files: ['**/*.{ts,mts,tsx,vue}'],
  },

  {
    name: 'app/files-to-ignore',
    ignores: [
      '**/dist/**',
      '**/dist-ssr/**',
      '**/coverage/**',
      '**/*.cjs',
      // Playwright-generated output (traces, HTML report + bundled trace viewer,
      // per-run artifacts). Regenerated on every e2e run and never hand-edited.
      '**/test-results/**',
      '**/playwright-report/**',
      '**/playwright-report-e2e/**',
      '**/blob-report/**',
      '**/playwright/.cache/**',
    ],
  },

  pluginVue.configs['flat/essential'],
  vueTsConfigs.recommended,
  skipFormatting,
  {
    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/require-v-for-key': 'warn',
      'vue/no-use-v-if-with-v-for': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '(^_|Schema$)',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    name: 'allow-cjs-build-scripts',
    files: ['**/build/scripts/*.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
)
