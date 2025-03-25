export default {
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]sx?$': 'babel-jest'
  },
  moduleNameMapper: {
    '^(.*)\\.js$': '$1',
  },
  testMatch: ['<rootDir>/tests/**/*Test.ts'],
  collectCoverage: true,
  collectCoverageFrom: ['<rootDir>/src/**/*.ts'],
  transformIgnorePatterns: [
    '/node_modules/(?!@alphabill|@unicitylabs)'
  ],
};
