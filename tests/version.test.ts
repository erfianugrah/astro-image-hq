import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PKG_VERSION } from "../src/version.js";

describe("PKG_VERSION", () => {
  it("matches package.json version", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "..", "package.json"), "utf-8"),
    );
    expect(PKG_VERSION).toBe(pkg.version);
  });
});
