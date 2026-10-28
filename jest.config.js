const swc = [
  '@swc/jest',
  {
    jsc: {
      target: 'es2022',
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
    },
    module: { type: 'commonjs' },
  },
];

const base = {
  testEnvironment: 'node',
  transform: { '^.+\\.(t|j)sx?$': swc },
  // better-auth and its helpers ship ESM only; run them through swc too
  transformIgnorePatterns: ['/node_modules/(?!(better-auth|@better-auth|better-call|@noble|nanostores|jose|rou3|defu|@better-fetch)/)'],
  moduleNameMapper: {
    '^@qorloop/shared$': '<rootDir>/packages/shared/src/index.ts',
    '^@qorloop/core$': '<rootDir>/packages/core/src/index.ts',
    '^@qorloop/db$': '<rootDir>/packages/db/src/index.ts',
  },
};

module.exports = {
  projects: [
    {
      ...base,
      displayName: 'unit',
      roots: ['<rootDir>/packages', '<rootDir>/apps'],
      testMatch: ['**/__tests__/**/*.test.ts', '**/*.spec.ts'],
      testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    },
    {
      ...base,
      displayName: 'e2e',
      roots: ['<rootDir>/apps/api/test'],
      testMatch: ['**/*.e2e-spec.ts'],
      setupFiles: ['<rootDir>/apps/api/test/env.ts'],
      testTimeout: 60000,
    },
  ],
};
