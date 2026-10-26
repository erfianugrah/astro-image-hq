/**
 * Package version, baked in at source level.
 *
 * Must stay in sync with package.json - tests/version.test.ts enforces it.
 * A runtime readFileSync of ../package.json breaks once Astro bundles the
 * service into dist/.prerender (the relative path no longer resolves), so
 * the version is a plain constant instead.
 */
export const PKG_VERSION = "0.1.6";
