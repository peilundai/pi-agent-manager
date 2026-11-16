import * as vscode from "vscode";
import { findEnvironmentReferences, missingReferences, type EnvironmentReference } from "../pi/config-references";
import { mergeEnvironment, resolveShellEnvironment, type ShellEnvironmentResult } from "../pi/shell-environment";

const SECRET_PREFIX = "piAgentManager.env.";
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type VariableSource = "secret" | "setting" | "VS Code" | "login shell" | "missing";

export interface ResolvedEnvironment {
  env: NodeJS.ProcessEnv;
  shell: ShellEnvironmentResult;
  sourceOf(name: string): VariableSource;
}

export interface PiEnvironmentOptions {
  secrets: vscode.SecretStorage;
  log: Pick<vscode.LogOutputChannel, "info" | "warn" | "show">;
  /** Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  resolveShell?: typeof resolveShellEnvironment;
  findReferences?: typeof findEnvironmentReferences;
}

function configuration() {
  return vscode.workspace.getConfiguration("piAgentManager");
}

function plural(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}

/**
 * Builds the environment Pi runs with: VS Code's environment, plus what the user's login
 * shell adds, plus `piAgentManager.environment`, plus secrets kept in VS Code's encrypted
 * secret storage. Secret values are never logged or shown.
 */
export class PiEnvironment {
  private shell: Promise<ShellEnvironmentResult> | undefined;
  private readonly warned = new Set<string>();

  constructor(private readonly options: PiEnvironmentOptions) {}

  private get baseEnv(): NodeJS.ProcessEnv {
    return this.options.baseEnv ?? process.env;
  }

  /** Starts loading the login-shell environment early so the first chat does not wait for it. */
  preload(): void {
    void this.shellEnvironment();
  }

  /** Forgets the cached shell environment and warnings; the next start reloads both. */
  reload(): void {
    this.shell = undefined;
    this.warned.clear();
  }

  private shellEnvironment(): Promise<ShellEnvironmentResult> {
    if (!configuration().get<boolean>("loadShellEnvironment", true)) {
      return Promise.resolve({ status: "skipped", reason: "piAgentManager.loadShellEnvironment is off." });
    }
    this.shell ??= (this.options.resolveShell ?? resolveShellEnvironment)({ env: this.baseEnv }).then((result) => {
      if (result.status === "loaded") {
        this.options.log.info(`Loaded ${Object.keys(result.env).length} environment variables from ${result.shell} in ${result.durationMs} ms.`);
      } else if (result.status === "failed") {
        this.options.log.warn(`Could not load the login-shell environment: ${result.error} Pi uses VS Code's environment instead.`);
      } else {
        this.options.log.info(`Login-shell environment not loaded: ${result.reason}`);
      }
      return result;
    });
    return this.shell;
  }

  private settingValues(): Record<string, string> {
    const value = configuration().get<unknown>("environment", {});
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => VARIABLE_NAME.test(entry[0]) && typeof entry[1] === "string"),
    );
  }

  async secretNames(): Promise<string[]> {
    const keys = await this.options.secrets.keys();
    return keys
      .filter((key) => key.startsWith(SECRET_PREFIX))
      .map((key) => key.slice(SECRET_PREFIX.length))
      .filter((name) => VARIABLE_NAME.test(name))
      .sort();
  }

  private async secretValues(): Promise<Record<string, string>> {
    const names = await this.secretNames();
    const values = await Promise.all(names.map((name) => this.options.secrets.get(`${SECRET_PREFIX}${name}`)));
    return Object.fromEntries(names.flatMap((name, index) => (values[index] === undefined ? [] : [[name, values[index]]])));
  }

  async setSecret(name: string, value: string): Promise<void> {
    if (!VARIABLE_NAME.test(name)) throw new Error(`“${name}” is not a valid environment variable name.`);
    await this.options.secrets.store(`${SECRET_PREFIX}${name}`, value);
    this.warned.delete(name);
  }

  async deleteSecret(name: string): Promise<void> {
    await this.options.secrets.delete(`${SECRET_PREFIX}${name}`);
  }

  async resolveDetailed(): Promise<ResolvedEnvironment> {
    const base = this.baseEnv;
    const [shell, secrets] = await Promise.all([this.shellEnvironment(), this.secretValues()]);
    const settings = this.settingValues();
    const shellEnv = shell.status === "loaded" ? shell.env : undefined;
    const env = mergeEnvironment({ base, shell: shellEnv, overrides: { ...settings, ...secrets } });
    return {
      env,
      shell,
      sourceOf(name) {
        if (name in secrets) return "secret";
        if (name in settings) return "setting";
        if (base[name]) return "VS Code";
        if (shellEnv?.[name]) return "login shell";
        return "missing";
      },
    };
  }

  /** The environment to start Pi with. */
  async resolve(): Promise<NodeJS.ProcessEnv> {
    return (await this.resolveDetailed()).env;
  }

  async missing(cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<EnvironmentReference[]> {
    const references = await (this.options.findReferences ?? findEnvironmentReferences)({ env, ...(cwd ? { cwd } : {}) });
    return missingReferences(references, env);
  }

  /**
   * Warns once per variable when Pi's config references a variable that is not set, with
   * one-click fixes. Without this, a gateway sees an empty or placeholder key and returns
   * an unhelpful authentication error.
   */
  async checkMissing(cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<void> {
    const names = (await this.missing(cwd, env)).map((reference) => reference.name).filter((name) => !this.warned.has(name));
    if (!names.length) return;
    for (const name of names) this.warned.add(name);
    const message = `Pi's configuration uses ${plural(names)}, but ${names.length === 1 ? "it is" : "they are"} not set in VS Code or your login shell. Providers or MCP servers that need ${names.length === 1 ? "it" : "them"} will fail to authenticate.`;
    const choice = await vscode.window.showWarningMessage(message, "Set Secret…", "Show Details");
    if (choice === "Set Secret…") await vscode.commands.executeCommand("piAgentManager.setEnvironmentSecret", names[0]);
    else if (choice === "Show Details") await vscode.commands.executeCommand("piAgentManager.showEnvironmentDiagnostics");
  }

  /** Writes a report of where each referenced variable comes from, without values. */
  async showDiagnostics(cwd: string | undefined): Promise<void> {
    const resolved = await this.resolveDetailed();
    const references = await (this.options.findReferences ?? findEnvironmentReferences)({ env: resolved.env, ...(cwd ? { cwd } : {}) });
    const log = this.options.log;
    const shell = resolved.shell;
    log.info("Environment diagnostics (values are never shown)");
    if (shell.status === "loaded") log.info(`Login shell: ${shell.shell}, ${Object.keys(shell.env).length} variables in ${shell.durationMs} ms`);
    else if (shell.status === "failed") log.warn(`Login shell: failed: ${shell.error}`);
    else log.info(`Login shell: skipped: ${shell.reason}`);
    const secrets = await this.secretNames();
    log.info(`Stored secrets: ${secrets.length ? secrets.join(", ") : "none"}`);
    if (!references.length) log.info("Pi's models.json and mcp.json reference no environment variables.");
    for (const reference of references) {
      const source = resolved.sourceOf(reference.name);
      const line = `${reference.name}: ${source === "missing" ? "MISSING" : `set (${source})`}, used by ${reference.field} in ${reference.file}`;
      if (source === "missing") log.warn(line);
      else log.info(line);
    }
    log.show(true);
  }
}

export interface EnvironmentCommandOptions {
  environment: PiEnvironment;
  cwd(): string | undefined;
  /** Restarts Pi so it picks up the changed environment. */
  restart(): Promise<void>;
}

async function pickVariableName(options: EnvironmentCommandOptions, preset: unknown): Promise<string | undefined> {
  if (typeof preset === "string" && VARIABLE_NAME.test(preset)) return preset;
  const { environment } = options;
  const missing = (await environment.missing(options.cwd(), await environment.resolve())).map((reference) => reference.name);
  const other = "Another variable…";
  if (missing.length) {
    const picked = await vscode.window.showQuickPick([...missing, other], {
      title: "Set Environment Secret",
      placeHolder: "Variables Pi's configuration needs but cannot find",
    });
    if (!picked) return undefined;
    if (picked !== other) return picked;
  }
  return vscode.window.showInputBox({
    title: "Set Environment Secret",
    prompt: "Environment variable name, for example GATEWAY_API_KEY",
    validateInput: (value) => (VARIABLE_NAME.test(value.trim()) ? undefined : "Use letters, digits and underscores, not starting with a digit."),
  }).then((value) => value?.trim() || undefined);
}

/** Registers the commands that manage Pi's environment. */
export function registerEnvironmentCommands(options: EnvironmentCommandOptions): vscode.Disposable[] {
  const { environment } = options;
  return [
    vscode.commands.registerCommand("piAgentManager.setEnvironmentSecret", async (preset?: unknown) => {
      const name = await pickVariableName(options, preset);
      if (!name) return;
      const value = await vscode.window.showInputBox({
        title: `Set ${name}`,
        prompt: `Value for ${name}. It is stored in VS Code's encrypted secret storage and passed only to Pi.`,
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      await environment.setSecret(name, value);
      await options.restart();
      void vscode.window.showInformationMessage(`Saved ${name}. Pi was restarted to use it.`);
    }),
    vscode.commands.registerCommand("piAgentManager.removeEnvironmentSecret", async () => {
      const names = await environment.secretNames();
      if (!names.length) {
        void vscode.window.showInformationMessage("No environment secrets are stored for Pi.");
        return;
      }
      const name = await vscode.window.showQuickPick(names, { title: "Remove Environment Secret" });
      if (!name) return;
      await environment.deleteSecret(name);
      await options.restart();
    }),
    vscode.commands.registerCommand("piAgentManager.reloadEnvironment", async () => {
      environment.reload();
      await options.restart();
    }),
    vscode.commands.registerCommand("piAgentManager.showEnvironmentDiagnostics", () => environment.showDiagnostics(options.cwd())),
  ];
}
