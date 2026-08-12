import { describe, expect, it } from "vitest";
import { generateSessionTitle } from "../src/pi/session-title";

describe("generateSessionTitle", () => {
  it("removes injected editor context before deriving the request", () => {
    expect(
      generateSessionTitle(
        "From `src/auth.ts` lines 8-12:\n\n```typescript\nconst secret = true;\n```\n\nPlease fix the token refresh race.",
      ),
    ).toBe("Fix the token refresh race");
  });

  it("truncates at a word boundary", () => {
    expect(generateSessionTitle("Investigate the authentication middleware regression in the production gateway", 36)).toBe(
      "Investigate the authentication…",
    );
  });

  it("returns undefined when no request text remains", () => {
    expect(generateSessionTitle("```ts\nconst onlyCode = true;\n```"))
      .toBeUndefined();
  });
});
