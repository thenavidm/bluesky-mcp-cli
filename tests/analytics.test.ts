import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../src/tools/index.js";

const NAMES = ["rank_posts", "get_post_stats", "get_engagement_summary", "get_posting_patterns"];

describe("analytics tools", () => {
  it("are registered, so both surfaces carry them", () => {
    const have = new Set(ALL_TOOLS.map((t) => t.name));
    expect(NAMES.filter((n) => !have.has(n))).toEqual([]);
  });

  it("are all reads, so none can be blocked by the write guard", () => {
    for (const name of NAMES) {
      expect(ALL_TOOLS.find((t) => t.name === name)?.risk).toBe("read");
    }
  });

  it("say what they measure, so a model picks the right one", () => {
    for (const name of NAMES) {
      const spec = ALL_TOOLS.find((t) => t.name === name);
      expect(spec?.description.length ?? 0).toBeGreaterThan(60);
    }
  });

  /**
   * Bluesky publishes no analytics endpoint, so every number here is arithmetic
   * over counts the feed already carries. If a tool ever needs an endpoint that
   * does not exist, it belongs in a collector, not in a tool call.
   */
  it("take an actor, so they work on any public account", () => {
    for (const name of ["rank_posts", "get_engagement_summary", "get_posting_patterns"]) {
      expect(Object.keys((ALL_TOOLS.find((t) => t.name === name)?.jsonSchema.properties as object) ?? {})).toContain("actor");
    }
  });
});
