/**
 * Happy Trader Funding — economics engine (M13.0).
 *
 * A deterministic, auditable business-economics simulator for stress-testing the
 * CURRENT account products under configurable assumptions. It is a scenario engine,
 * NOT a forecast, and it never touches production data. See docs/economics/.
 */
export * from './config.js';
export * from './engine.js';
export * from './scenarios.js';
export * from './analysis.js';
export * from './run.js';
export * as serialize from './serialize.js';
