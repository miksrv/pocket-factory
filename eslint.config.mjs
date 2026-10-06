// ESLint flat config for both workspaces, the tests and the repository scripts.
// Formatting is Prettier's job (`yarn format:check`); eslint-config-prettier
// switches off every stylistic rule that would fight it.
import js from '@eslint/js'
import vitest from '@vitest/eslint-plugin'
import { defineConfig, globalIgnores } from 'eslint/config'
import prettier from 'eslint-config-prettier/flat'
import playwright from 'eslint-plugin-playwright'
import reactHooks from 'eslint-plugin-react-hooks'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
    globalIgnores([
        '**/node_modules/',
        '**/dist/',
        '.yarn/',
        'data/',
        'coverage/',
        'playwright-report/',
        'test-results/',
        'blob-report/',
        '.e2e/',
        'playwright/',
        'templates/',
        'presets/'
    ]),

    js.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    // Config files outside every tsconfig still get type information.
                    allowDefaultProject: ['*.config.mjs', 'scripts/*.mjs']
                },
                tsconfigRootDir: import.meta.dirname
            }
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'error'
        },
        plugins: {
            'simple-import-sort': simpleImportSort
        },
        rules: {
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            curly: ['error', 'multi-line'],
            'no-console': ['error', { allow: ['warn', 'error'] }],
            'no-duplicate-imports': 'off',
            'no-else-return': 'error',
            'no-fallthrough': ['error', { commentPattern: 'falls? ?through' }],
            'object-shorthand': 'error',
            'prefer-const': 'error',

            'simple-import-sort/imports': [
                'error',
                {
                    // Node built-ins, then packages, then the project's own modules.
                    groups: [['^node:'], ['^react', '^@?\\w'], ['^\\.\\.', '^\\.'], ['^.+\\.css$']]
                }
            ],
            'simple-import-sort/exports': 'error',

            '@typescript-eslint/consistent-type-imports': [
                'error',
                { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
            ],
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }
            ],
            '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
            '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
            '@typescript-eslint/restrict-template-expressions': [
                'error',
                { allowNumber: true, allowBoolean: true, allowNullish: true }
            ],
            '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
            // Payloads are `unknown` JSON throughout; `String(value)` on them is deliberate.
            '@typescript-eslint/no-base-to-string': 'off',
            '@typescript-eslint/prefer-string-starts-ends-with': 'error'
        }
    },

    // The supervisor: Node, no DOM.
    {
        files: ['supervisor/**/*.ts'],
        languageOptions: { globals: globals.node }
    },

    // Hono's middleware types carry `any` in the Context input parameter.
    {
        files: ['supervisor/src/web/server.ts'],
        rules: { '@typescript-eslint/no-unsafe-argument': 'off' }
    },

    // The UI: browser globals and the React hooks rules.
    {
        files: ['web/**/*.{ts,tsx}'],
        languageOptions: { globals: globals.browser },
        extends: [reactHooks.configs.flat['recommended-latest']],
        rules: {
            // The React Compiler diagnostics. The UI is not compiled with it, and these flag
            // established patterns (state synced from a prop in an effect, refs read in render)
            // that work as written; switch them on together with the compiler.
            'react-hooks/immutability': 'off',
            'react-hooks/purity': 'off',
            'react-hooks/refs': 'off',
            'react-hooks/set-state-in-effect': 'off',
            'react-hooks/use-memo': 'off'
        }
    },

    // Unit and component tests (Vitest).
    {
        files: ['**/*.test.{ts,tsx}', 'supervisor/test/**', 'web/test/**'],
        extends: [vitest.configs.recommended],
        languageOptions: { globals: { ...globals.node } },
        rules: {
            'vitest/consistent-test-it': ['error', { fn: 'it' }],
            'vitest/no-focused-tests': 'error',
            'vitest/no-disabled-tests': 'warn',
            'vitest/prefer-to-be': 'error',
            'vitest/prefer-to-have-length': 'error',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/unbound-method': 'off'
        }
    },

    // End-to-end tests (Playwright).
    {
        files: ['e2e/**/*.ts'],
        extends: [playwright.configs['flat/recommended']],
        languageOptions: { globals: globals.node }
    },

    // Plain JavaScript: repository scripts and config files, no type information.
    {
        files: ['**/*.{js,mjs,cjs}'],
        extends: [tseslint.configs.disableTypeChecked],
        languageOptions: { globals: globals.node }
    },

    // Command-line scripts talk to the terminal.
    {
        files: ['scripts/**'],
        rules: { 'no-console': 'off' }
    },

    prettier
])
