/**
 * Public entry point for the Z.AI research feature.
 *
 * Architecture (revised 2026-06-27 — scoped MCP):
 * - The participant `@zai.research` is the only chat-surface entry point.
 *   It embeds MCP tool invocation directly via `vscode.lm.invokeTool()`.
 * - The MCP servers are registered via `vscode.lm.registerMcpServerDefinitionProvider`
 *   which **resolves on-demand** (only when a tool is actually invoked).
 *   This means the Z.AI Web Search + Reader tools are NOT globally available
 *   to Copilot Agent by default — they only activate when `@z-research`
 *   invokes them. Regular Copilot Agent chat is unaffected.
 * - No `mcp.json` file is written to the user's config dir. The servers
 *   live entirely in the extension's runtime.
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

/** Provider id — must match `contributes.mcpServerDefinitionProviders` in package.json. */
const MCP_PROVIDER_ID = "zai.mcpProvider";

/**
 * Register the @zai.research participant and the MCP server definition
 * provider. The MCP servers are NOT written to the user's `mcp.json` —
 * they are provided dynamically via `registerMcpServerDefinitionProvider`
 * and resolved on-demand (only when a tool is invoked).
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

  // --- MCP Server Definition Provider (scoped, on-demand) ---
  // This registers the Z.AI Web Search + Web Reader as MCP servers that
  // VS Code knows about, but they are only resolved (started) when a tool
  // is actually invoked — not eagerly at startup. The `resolveMcpServerDefinition`
  // callback checks for the API key and returns the server definition with
  // the auth header. If no key is set, it returns undefined (server skipped).
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
      provideMcpServerDefinitions(_token: vscode.CancellationToken) {
        return [
          new vscode.McpHttpServerDefinition(
            "Z.AI Web Search",
            vscode.Uri.parse(MCP_WEB_SEARCH_URL),
          ),
          new vscode.McpHttpServerDefinition(
            "Z.AI Web Reader",
            vscode.Uri.parse(MCP_WEB_READER_URL),
          ),
        ];
      },
      async resolveMcpServerDefinition(
        server: vscode.McpHttpServerDefinition,
        _token: vscode.CancellationToken,
      ): Promise<vscode.McpHttpServerDefinition | undefined> {
        const apiKey = await context.secrets.get(SECRET_KEY);
        if (!apiKey) {
          outputChannel.appendLine(
            `[${new Date().toISOString()}] [mcp-provider] No API key — skipping "${server.label}"`,
          );
          return undefined;
        }
        return new vscode.McpHttpServerDefinition(
          server.label,
          server.uri,
          { Authorization: `Bearer ${apiKey}` },
        );
      },
    }),
  );

  // --- Chat Participant (@zai.research) ---
  context.subscriptions.push(
    registerResearchParticipant({ context, mcpTools, outputChannel }),
  );

  outputChannel.appendLine(
    `[${new Date().toISOString()}] Z.AI research features registered: ` +
      `participant(@z-research), ` +
      `mcpProvider(${MCP_PROVIDER_ID}, on-demand resolve)`,
  );
}

/**
 * Read a configured MCP tool name from `zai.research.<key>`.
 */
function readMcpToolName(key: string, fallback: string): string {
  return vscode.workspace.getConfiguration("zai.research").get(key, fallback);
}
