import { defineConfig } from 'vitest/config';

/**
 * grammy ships as an ESM package with conditional exports. Under vitest, a
 * module that imports grammy (for example src/bot/keyboards.ts, which uses
 * InlineKeyboard) can end up with unresolved named exports, surfacing as
 * "X is not a function" for every export of that module.
 *
 * Inlining grammy forces vitest to transform it through the same pipeline as
 * our source, which resolves the interop cleanly. This changes no application
 * code and no test logic; it only tells the test runner how to load the dep.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    server: {
      deps: {
        inline: [/grammy/],
      },
    },
  },
});
