/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  collectCoverageFrom: ['{services,libs}/**/*.(t|j)s', '!**/*.spec.ts'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@signalman/otel(|/.*)$': '<rootDir>/libs/otel/src/$1',
    '^@signalman/propagation(|/.*)$': '<rootDir>/libs/propagation/src/$1',
  },
};
