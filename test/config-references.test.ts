import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultAgentDir,
  findEnvironmentReferences,
  missingReferences,
  referencedNames,
  referencesInConfig,
} from "../src/pi/config-references";

describe("referencedNames", () => {
  it("reads $NAME and ${NAME} interpolation and skips $$ and commands", () => {
    expect(referencedNames("$GATEWAY_KEY", "apiKey")).toEqual(["GATEWAY_KEY"]);
    expect(referencedNames("Bearer ${DOCS_TOKEN}", "Authorization")).toEqual(["DOCS_TOKEN"]);
    expect(referencedNames("cost $$5 for $A and ${B}", "x")).toEqual(["A", "B"]);
    expect(referencedNames("!op read op://vault/key", "apiKey")).toEqual([]);
  });

  it("treats *EnvVar keys as variable names and legacy all-caps API keys as names", () => {
    expect(referencedNames("EXA_API_KEY", "bearerTokenEnvVar")).toEqual(["EXA_API_KEY"]);
    expect(referencedNames("EXA_API_KEY", "env")).toEqual(["EXA_API_KEY"]);
    expect(referencedNames("not a name", "env")).toEqual([]);
    expect(referencedNames("COMPANY_GATEWAY_KEY", "apiKey", true)).toEqual(["COMPANY_GATEWAY_KEY"]);
    expect(referencedNames("sk-literal-key", "apiKey", true)).toEqual([]);
    expect(referencedNames("COMPANY_GATEWAY_KEY", "apiKey")).toEqual([]);
  });
});

describe("referencesInConfig", () => {
  it("finds gateway keys and headers in models.json", () => {
    const models = JSON.stringify({
      providers: {
        gateway: {
          baseUrl: "https://llm.example.com/v1",
          apiKey: "${GATEWAY_API_KEY}",
          headers: { "x-team": "$TEAM_ID" },
          models: [{ id: "m", headers: { "x-extra": "${EXTRA}" }, name: "$NOT_A_REFERENCE" }],
        },
      },
    });
    expect(referencesInConfig(models, "models.json")).toEqual([
      { name: "GATEWAY_API_KEY", file: "models.json", field: "providers.gateway.apiKey" },
      { name: "TEAM_ID", file: "models.json", field: "providers.gateway.headers.x-team" },
      { name: "EXTRA", file: "models.json", field: "providers.gateway.models.0.headers.x-extra" },
    ]);
  });

  it("finds MCP env and header references, including { env: NAME } values", () => {
    const mcp = JSON.stringify({
      mcpServers: {
        exa: { url: "https://mcp.exa.ai/mcp", headers: { "x-api-key": { env: "EXA_API_KEY" } } },
        docs: { url: "https://docs/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
        tools: { command: "uvx", args: ["$ARG_NOT_CHECKED"], env: { API_KEY: "${TOOLS_KEY}" } },
      },
    });
    expect(referencesInConfig(mcp, "mcp.json").map((reference) => reference.name)).toEqual(["EXA_API_KEY", "DOCS_TOKEN", "TOOLS_KEY"]);
  });

  it("ignores malformed JSON", () => {
    expect(referencesInConfig("{", "x")).toEqual([]);
  });
});

describe("findEnvironmentReferences", () => {
  it("reads user models.json and mcp.json plus the project mcp.json", async () => {
    const files: Record<string, string> = {
      [join("/agent", "models.json")]: JSON.stringify({ providers: { gw: { apiKey: "$GW" } } }),
      [join("/work", ".pi", "mcp.json")]: JSON.stringify({ mcpServers: { a: { headers: { k: "${PROJECT}" } } } }),
    };
    const readFile = async (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    };
    const references = await findEnvironmentReferences({ env: { PI_CODING_AGENT_DIR: "/agent" }, cwd: "/work", readFile });
    expect(references.map((reference) => reference.name)).toEqual(["GW", "PROJECT"]);
    expect(defaultAgentDir({})).toMatch(/\.pi[\\/]agent$/);
  });

  it("lists each unset or empty variable once", () => {
    const references = [
      { name: "A", file: "f", field: "x" },
      { name: "A", file: "g", field: "y" },
      { name: "B", file: "f", field: "z" },
      { name: "C", file: "f", field: "w" },
    ];
    expect(missingReferences(references, { B: "set", C: "" }).map((reference) => [reference.name, reference.file])).toEqual([
      ["A", "f"],
      ["C", "f"],
    ]);
  });
});
