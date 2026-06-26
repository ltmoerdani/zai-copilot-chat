/**
 * Public entry point for the Z.AI research feature.
 *
 * Architecture (revised 2026-06-27 — no VS Code MCP registration):
 * - The participant `@zai.research` is the only chat-surface entry point.
 * - The MCP servers are NOT registered with VS Code at all — neither via
 *   `mcp.json` nor via `mcpServerDefinitionProvider`. This ensures the
 *   Z.AI Web Search + Reader tools are completely invisible to Copilot
 *   Agent and other chat participants.
 * - Instead, `McpToolInvoker` calls the Z.AI Streamable HTTP MCP endpoints
 *   directly via `fetch()`. The `@z-research` participant orchestrates
 *   these calls in its own loop, bypassing VS Code's tool infrastructure.
 *
 * Called once from `extension.ts#activate`.
 */

import * as vscode from "vscode";
import { McpToolInvoker } from "./mcpTools";
import { registerResearchParticipant } from "./researchParticipant";

/**
 * Register the @zai.research participant.
 *
 * No MCP servers are registered with VS Code. The participant calls
 * the Z.AI MCP HTTP endpoints directly.
 */
export function registerResearchFeatures(
  context: vscode.ExtensionContext,
): void {
  const outputChannel = vscode.window.createOutputChannel("Z.AI Research");
  context.subscriptions.push(outputChannel);

  const mcpTools = new McpToolInvoker({
    webSearchToolName: readMcpToolName("webSearchToolName", "web_search_prime"),
    webReaderToolName: readMcpToolName("webReaderToolName", "webReader"),
    outputChannel,
    secrets: context.secrets,
  });

  context.subscriptions.push(
    registerResearchParticipant({ context, mcpTools, outputChannel }),
  );

  outputChannel.appendLine(
    `[${new Date().toISOString()}] Z.AI research features registered: ` +
      `participant(@z-research), direct HTTP MCP (no VS Code registration)`,
  );
}

function readMcpToolName(key: string, fallback: string): string {
  return vscode.workspace.getConfiguration("zai.research").get(key, fallback);
}
