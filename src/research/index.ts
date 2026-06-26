/**
 * Public entry point for the Z.AI research feature.
 *
 * Architecture (revised 2026-06-26 — clean UI):
 * - The participant `@zai.research` is the only chat-surface entry point.
 *   It embeds MCP tool invocation directly via `vscode.lm.invokeTool()`.
 * - The MCP servers themselves are configured **out of band** by the
 *   `Z.AI: Setup MCP Servers` command, which writes the user's
 *   `mcp.json` with both servers and the API key.
 * - This keeps the chat dropdown focused: only `@zai.research` shows.
 *
 * Called once from `extension.ts#activate`.
 */

import * as vscode from "vscode";
import { McpToolInvoker } from "./mcpTools";
import { registerResearchParticipant } from "./researchParticipant";

/** SecretStorage key reused from the chat provider. */
const SECRET_KEY = "zai.apiKey";

/** Z.AI MCP server Streamable HTTP endpoints (Coding Plan exclusive). */
const MCP_WEB_SEARCH_URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";
const MCP_WEB_READER_URL = "https://api.z.ai/api/mcp/web_reader/mcp";

/**
 * Register the @zai.research participant and the `Z.AI: Setup MCP Servers`
 * command. The MCP servers themselves are NOT registered as a definition
 * provider — the user is expected to run the setup command which writes
 * the MCP configuration to their VS Code user `mcp.json`.
 */
export function registerResearchFeatures(
  context: vscode.ExtensionContext,
): void {
  const outputChannel = vscode.window.createOutputChannel("Z.AI Research");
  context.subscriptions.push(outputChannel);

  /** Helper that invokes the MCP tools via `vscode.lm.invokeTool`. */
  const mcpTools = new McpToolInvoker({
    webSearchToolName: readMcpToolName("webSearchToolName", "web_search_prime"),
    webReaderToolName: readMcpToolName("webReaderToolName", "webReader"),
    outputChannel,
  });

  // --- Chat Participant (@zai.research) ---
  context.subscriptions.push(
    registerResearchParticipant({ context, mcpTools, outputChannel }),
  );

  // --- Setup command (writes mcp.json once) ---
  context.subscriptions.push(
    vscode.commands.registerCommand("zai.setupMcp", async () => {
      await runSetupMcpCommand(context, outputChannel);
    }),
  );

  outputChannel.appendLine(
    `[${new Date().toISOString()}] Z.AI research features registered: ` +
      `participant(@z-research), ` +
      `command(zai.setupMcp)`,
  );
}

/**
 * Read a configured MCP tool name from `zai.research.<key>`. The tool names
 * VS Code actually exposes (e.g. `mcp_mcp-web-searc_web_search_prime`) are
 * subject to change between VS Code versions, so we expose them as settings
 * for easy override without code changes.
 */
function readMcpToolName(key: string, fallback: string): string {
  return vscode.workspace.getConfiguration("zai.research").get(key, fallback);
}

/**
 * Write the Z.AI MCP server configuration to the user's `mcp.json` file.
 * The user must reload VS Code after this runs.
 */
async function runSetupMcpCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const apiKey = await context.secrets.get(SECRET_KEY);
  if (!apiKey) {
    vscode.window.showWarningMessage(
      "Z.AI: Set your API key first ('Z.AI: Set API Key'), then run this command again.",
    );
    return;
  }

  const configPath = await resolveMcpJsonUri();
  if (!configPath) {
    vscode.window.showErrorMessage(
      "Z.AI: Could not locate VS Code's mcp.json path. Configure MCP servers manually.",
    );
    return;
  }

  let existing: Record<string, unknown> = {};
  try {
    const raw = await vscode.workspace.fs.readFile(configPath);
    const parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
    if (parsed && typeof parsed === "object" && parsed.servers && typeof parsed.servers === "object") {
      existing = parsed.servers as Record<string, unknown>;
    }
  } catch {
    // File doesn't exist or is invalid JSON — start fresh.
  }

  const alreadyConfigured =
    "zai-web-search-prime" in existing && "zai-web-reader" in existing;
  if (alreadyConfigured) {
    vscode.window.showInformationMessage(
      "Z.AI: MCP servers are already configured in mcp.json. Reload VS Code to pick up changes.",
    );
    return;
  }

  const next = {
    ...existing,
    "zai-web-search-prime": {
      type: "http",
      url: MCP_WEB_SEARCH_URL,
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    "zai-web-reader": {
      type: "http",
      url: MCP_WEB_READER_URL,
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  };

  const payload = JSON.stringify({ servers: next }, null, 2);
  try {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(configPath, ".."),
    );
  } catch {
    // Directory may already exist.
  }
  await vscode.workspace.fs.writeFile(
    configPath,
    new Uint8Array(Buffer.from(payload, "utf8")),
  );

  outputChannel.appendLine(
    `[${new Date().toISOString()}] [setup] wrote MCP config to ${configPath.fsPath}`,
  );

  const choice = await vscode.window.showInformationMessage(
    `Z.AI: MCP config written to ${configPath.fsPath}. Reload VS Code to enable.`,
    "Reload",
  );
  if (choice === "Reload") {
    vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

/**
 * Resolve the absolute path to the user's `mcp.json` file.
 */
async function resolveMcpJsonUri(): Promise<vscode.Uri | undefined> {
  const appName = vscode.env.appName;
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    const home = process.env.HOME ?? "";
    if (appName.toLowerCase().includes("insiders")) {
      candidates.push(`${home}/Library/Application Support/Code - Insiders/User/mcp.json`);
    }
    candidates.push(`${home}/Library/Application Support/Code/User/mcp.json`);
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? "";
    if (appName.toLowerCase().includes("insiders")) {
      candidates.push(`${appData}\\Code - Insiders\\User\\mcp.json`);
    }
    candidates.push(`${appData}\\Code\\User\\mcp.json`);
  } else {
    const home = process.env.HOME ?? "";
    if (appName.toLowerCase().includes("insiders")) {
      candidates.push(`${home}/.config/Code - Insiders/User/mcp.json`);
    }
    candidates.push(`${home}/.config/Code/User/mcp.json`);
  }
  for (const p of candidates) {
    const dir = vscode.Uri.file(p.replace(/[\\/]mcp\.json$/, ""));
    try {
      await vscode.workspace.fs.stat(dir);
      return vscode.Uri.file(p);
    } catch {
      return vscode.Uri.file(p);
    }
  }
  return undefined;
}
