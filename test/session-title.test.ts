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

  it("strips longer fences while preserving shorter fences inside the selection", () => {
    expect(
      generateSessionTitle(
        "From `docs/example.md` lines 2-6:\n\n````markdown\n```ts\nconst nested = true;\n```\n````\n\nPlease explain the nested example.",
      ),
    ).toBe("Explain the nested example");
  });

  it("accepts a closing fence longer than its opening fence", () => {
    expect(generateSessionTitle("```ts\nconst code = true;\n`````\n\nPlease review the code."))
      .toBe("Review the code");
  });
});
