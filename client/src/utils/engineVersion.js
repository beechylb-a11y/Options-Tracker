// Engine version stamps (Nov 2026). Values are baked in at build time by
// vite.config.js; 'dev' / 'unknown' when the build did not define them.
/* global __ENGINE_COMMIT__, __RULES_HASH__ */
export const ENGINE_COMMIT = typeof __ENGINE_COMMIT__ !== 'undefined' ? __ENGINE_COMMIT__ : 'dev';
export const RULES_HASH = typeof __RULES_HASH__ !== 'undefined' ? __RULES_HASH__ : 'unknown';

/** One line for trade notes: "Engine: 1dc5513 · rules 3fa9c0e1b2". */
export const versionLine = () => `Engine: ${ENGINE_COMMIT} · rules ${RULES_HASH}`;
