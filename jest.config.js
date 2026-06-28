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
    '^@signalman/logging(|/.*)$': '<rootDir>/libs/logging/src/$1',
    '^@signalman/interceptor(|/.*)$': '<rootDir>/libs/interceptor/src/$1',
    '^@signalman/outbox(|/.*)$': '<rootDir>/libs/outbox/src/$1',
    '^@signalman/inbox(|/.*)$': '<rootDir>/libs/inbox/src/$1',
  },
};
