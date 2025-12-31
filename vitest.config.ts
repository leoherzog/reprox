import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // 30s for integration tests with network requests
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            // Pass environment variables to Workers runtime for integration tests
            // Use empty strings as defaults since undefined is rejected
            GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '',
            RUN_INTEGRATION_TESTS: process.env.RUN_INTEGRATION_TESTS ?? '',
          },
        },
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/types.ts',
      ],
      thresholds: {
        // Set reasonable thresholds based on current coverage
        // These can be increased as coverage improves
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
    },
  },
});
