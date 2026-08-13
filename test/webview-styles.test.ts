import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const managerStyles = readFileSync(
  resolve("src/webview/styles.css"),
  "utf8",
);

describe("webview frame styles", () => {
  it("fills the host width without inherited horizontal body gutters", () => {
    const hostDefaults = document.createElement("style");
    hostDefaults.textContent = "body { padding: 0 20px; }";
    const extensionStyles = document.createElement("style");
    extensionStyles.textContent = managerStyles;
    document.head.append(hostDefaults, extensionStyles);

    try {
      const bodyStyle = getComputedStyle(document.body);
      expect(bodyStyle.paddingLeft).toBe("0px");
      expect(bodyStyle.paddingRight).toBe("0px");
    } finally {
      hostDefaults.remove();
      extensionStyles.remove();
    }
  });
});
