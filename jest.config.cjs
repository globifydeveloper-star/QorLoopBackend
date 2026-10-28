module.exports = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: true, tsconfig: { module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022', isolatedModules: true, experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true, skipLibCheck: true, types: ['node', 'jest'] } }] },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testMatch: ['<rootDir>/packages/**/__tests__/**/*.test.ts', '<rootDir>/apps/**/__tests__/**/*.test.ts'],
  maxWorkers: 1,
  testTimeout: 60000,
};

