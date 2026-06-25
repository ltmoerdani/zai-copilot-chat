/**
 * Public entry point for the Z.AI research feature (Phase 1 — Part A).
 *
 * Wires up the {@link ZaiApiClient} and registers the two language model tools
 * (`zai_webSearch`, `zai_webRead`) with VS Code. Called once from
 * `extension.ts#activate`.
 *
 * Phase 2 will add the `@zai.research` chat participant here as well.
 */

import * as vscode from "vscode";
import { ZaiApiClient } from "./zaiApiClient";
import { ZaiWebSearchTool } from "./webSearchTool";
import { ZaiWebReadTool } from "./webReadTool";

/** Tool name constants — must match `contributes.languageModelTools` in package.json. */
export const WEB_SEARCH_TOOL_NAME = "zai_webSearch";
export const WEB_READ_TOOL_NAME = "zai_webRead";

/** SecretStorage key reused from the chat provider. */
const SECRET_KEY = "zai.apiKey";

/**
 * Register all Phase 1 research features. Disposables are pushed onto the
 * extension context so they are cleaned up automatically on deactivate.
 */
export function registerResearchFeatures(
  context: vscode.ExtensionContext,
): void {
  const outputChannel = vscode.window.createOutputChannel("Z.AI Research");
  context.subscriptions.push(outputChannel);

  /** Lazily read the current API key from SecretStorage. */
  const apiKeyProvider = async () => {
    const value = await context.secrets.get(SECRET_KEY);
    return value ?? undefined;
  };

  /** Single shared client so retries/timeouts are configured consistently. */
  const client = new ZaiApiClient({
    apiKeyProvider,
    requestTimeoutMs: readRequestTimeoutMs(),
    maxRetries: readMaxRetries(),
    outputChannel,
  });

  /**
   * The client is stateless, but the provider indirection keeps the door open
   * for re-reading config (e.g. after a setting change) without re-creating
   * the tool instances.
   */
  const clientProvider = async () => client;

  context.subscriptions.push(
    vscode.lm.registerTool(
      WEB_SEARCH_TOOL_NAME,
      new ZaiWebSearchTool(clientProvider),
    ),
    vscode.lm.registerTool(
      WEB_READ_TOOL_NAME,
      new ZaiWebReadTool(clientProvider),
    ),
  );

  outputChannel.appendLine(
    `[${new Date().toISOString()}] Z.AI research tools registered: ${WEB_SEARCH_TOOL_NAME}, ${WEB_READ_TOOL_NAME}`,
  );
}

/** Read the configured request timeout, falling back to the chat default. */
function readRequestTimeoutMs(): number {
  return vscode.workspace.getConfiguration("zai").get("requestTimeout", 60_000);
}

/** Read the configured max retries, falling back to the chat default. */
function readMaxRetries(): number {
  return vscode.workspace.getConfiguration("zai").get("maxRetries", 2);
}
