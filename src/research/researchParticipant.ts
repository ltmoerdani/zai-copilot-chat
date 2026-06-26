/**
 * Chat participant `@zai.research` — Phase 2 entry point (Part B).
 *
 * The participant owns the chat request lifecycle: it builds the
 * {@link ResearchOrchestrator}, streams progress phases into the chat UI, and
 * renders the final synthesis with clickable citation anchors.
 *
 * LLM calls for planning / synthesis go through a small adapter that hits the
 * Z.AI chat completions endpoint (non-streaming) using the user's BYOK key.
 */

import * as vscode from "vscode";

import { ResearchCache } from "./cache";
import { McpToolInvoker } from "./mcpTools";
import { ResearchOrchestrator, type ResearchLLM } from "./orchestrator";
import {
  MissingApiKeyError,
  ZaiApiError,
  type ResearchConfig,
  type ResearchPhase,
  type ResearchResult,
} from "./types";

/** Participant id — must match `contributes.chatParticipants` in package.json. */
export const RESEARCH_PARTICIPANT_ID = "zai.research";

/** SecretStorage key reused from the chat provider. */
const SECRET_KEY = "zai.apiKey";

/** Default chat endpoint for planning / synthesis calls. */
const ZAI_CHAT_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions";

/** Default model for synthesis LLM calls. */
const DEFAULT_SYNTHESIS_MODEL = "glm-5.2";

export interface ParticipantDeps {
  context: vscode.ExtensionContext;
  mcpTools: McpToolInvoker;
  outputChannel: vscode.OutputChannel;
}

/**
 * Register the `@zai.research` chat participant. The returned disposable is
 * pushed onto the extension context by the caller.
 */
export function registerResearchParticipant(deps: ParticipantDeps): vscode.ChatParticipant {
  const { context, mcpTools, outputChannel } = deps;

  const participant = vscode.chat.createChatParticipant(
    RESEARCH_PARTICIPANT_ID,
    async (request, _ctx, stream, token) => {
      // Forward the chat request's tool invocation token to MCP calls so
      // VS Code treats them as user-authorised (no confirmation modal).
      const topic = request.prompt.trim();
      if (!topic) {
        stream.markdown(
          "_Tell me what to research. Example:_ `@zai.research /deep state of AI coding agents in 2026`",
        );
        return;
      }

      // Resolve config (mode from keyword in prompt + user settings).
      const config = resolveConfig(topic);

      // Build an AbortController linked to VS Code's cancellation token so a
      // user "Stop" aborts in-flight LLM calls.
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      // Cache: persistent tier lives under globalStorage; TTL from config.
      const cache = new ResearchCache({
        ttlSeconds: config.cacheTtlSeconds,
        globalStorageUri: context.globalStorageUri,
      });

      // LLM adapter for planning + synthesis (non-streaming chat completions).
      const llm = new ZaiChatLLM(
        () => context.secrets.get(SECRET_KEY),
        config.synthesisModel,
        outputChannel,
      );

      // Pre-flight: MCP tools must be connected before we can run research.
      // Check if API key is set (MCP tools call Z.AI HTTP endpoints directly).
      if (!(await mcpTools.isReady())) {
        stream.markdown(
          "⚠️ **Z.AI API key is not set.**\n\n" +
            "Run **Z.AI: Set API Key** from the Command Palette to configure your key, " +
            "then re-run `@z-research`.",
        );
        return;
      }

      const orchestrator = new ResearchOrchestrator({
        mcpTools,
        llm,
        cache,
        config,
        topic,
        signal: controller.signal,
        toolInvocationToken: request.toolInvocationToken,
        log: (msg) => outputChannel.appendLine(`[${new Date().toISOString()}] [orchestrator] ${msg}`),
      });

      stream.progress(`Planning research queries for "${topic}"…`);
      let result;
      try {
        result = await consumeOrchestrator(orchestrator, stream);
      } catch (error) {
        renderError(stream, error);
        return { errorDetails: { message: errorMessage(error) } } as vscode.ChatResult;
      }

      if (!result) {
        // Fallback: orchestrator produced no return value (e.g. aborted).
        stream.markdown("_Research did not complete. Try again or use `/quick` mode._");
        return;
      }

      // Render synthesis. The reduce step already produces a "## Sources"
      // section at the end with `[n]` citations and clickable URLs, so
      // we do NOT append a second sources list here (that would duplicate
      // every source).
      stream.markdown(result.synthesis);

      stream.markdown(
        `\n\n_Stats: ${result.stats.queriesRun} queries · ${result.stats.urlsConsidered} URLs considered · ${result.stats.sourcesRead} sources read · ${result.stats.iterations} iterations · ${(result.stats.durationMs / 1000).toFixed(1)}s_`,
      );
    },
  );

  participant.iconPath = new vscode.ThemeIcon("search");
  return participant;
}

/**
 * Drive the orchestrator's async generator to completion, surfacing each
 * progress phase to the chat stream and returning the final result.
 *
 * `for await ... of` discards an async generator's `return` value, so we
 * consume via `.next()` manually to capture it.
 */
async function consumeOrchestrator(
  orchestrator: ResearchOrchestrator,
  stream: vscode.ChatResponseStream,
): Promise<ResearchResult | undefined> {
  const gen = orchestrator.run();
  while (true) {
    const next = await gen.next();
    if (next.done) {
      return next.value;
    }
    renderPhase(stream, next.value);
  }
}

/** Map user prompt → concrete {@link ResearchConfig}. */
function resolveConfig(prompt: string): ResearchConfig {
  const cfg = vscode.workspace.getConfiguration("zai.research");
  const lower = prompt.toLowerCase();

  // Keyword-based mode detection. Slash commands were removed in favour of
  // a single clean chat-surface entry point; users can still opt into deep
  // mode with natural language cues.
  const isDeep =
    lower.startsWith("/deep") ||
    /\b(deep|thorough|comprehensive|exhaustive|menyeluruh|lengkap)\b/.test(lower);

  return {
    mode: isDeep ? "deep" : "quick",
    maxSources: cfg.get("maxSources", isDeep ? 100 : 20),
    maxIterations: cfg.get("maxIterations", isDeep ? 5 : 2),
    concurrency: cfg.get("concurrency", 3),
    cacheTtlSeconds: cfg.get("cacheTTL", 3600),
    synthesisModel: cfg.get("synthesisModel", DEFAULT_SYNTHESIS_MODEL),
  };
}
function renderPhase(stream: vscode.ChatResponseStream, phase: ResearchPhase): void {
  switch (phase.kind) {
    case "plan":
      stream.progress(`Planned ${phase.queries.length} search queries.`);
      break;
    case "search":
      stream.progress(`Search "${phase.query}" → ${phase.resultCount} results.`);
      break;
    case "read":
      stream.progress(
        phase.ok ? `Read ${phase.title ?? phase.url}` : `Skipped ${phase.url}`,
      );
      break;
    case "rank":
      stream.progress(`Ranked: kept ${phase.kept}, dropped ${phase.dropped}.`);
      break;
    case "synthesize":
      stream.progress(`Synthesizing across ${phase.chunks} chunk(s)…`);
      break;
    case "done":
      stream.progress(`Done: ${phase.sources} sources, ${phase.citations} citations.`);
      break;
  }
}

function renderError(stream: vscode.ChatResponseStream, error: unknown): void {
  stream.markdown(`⚠️ ${errorMessage(error)}`);
}

function errorMessage(error: unknown): string {
  if (error instanceof MissingApiKeyError) {
    return "Z.AI API key not set. Run 'Z.AI: Set API Key' in the Command Palette, then retry.";
  }
  if (error instanceof ZaiApiError) {
    return `Z.AI error (HTTP ${error.status}): ${error.message}`;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "Research cancelled.";
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// LLM adapter — non-streaming chat completions via the Z.AI endpoint.
// ---------------------------------------------------------------------------

/**
 * Adapter that lets the orchestrator call the LLM without depending on the
 * streaming provider machinery. Uses a single non-streaming chat completion
 * per call, which is what we want for short planning prompts and large
 * synthesis prompts alike.
 */
class ZaiChatLLM implements ResearchLLM {
  constructor(
    private readonly apiKeyProvider: () => Thenable<string | undefined>,
    private readonly model: string,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  async complete(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const apiKey = await this.apiKeyProvider();
    if (!apiKey) throw new MissingApiKeyError();

    const controller = new AbortController();
    if (signal) signal.addEventListener("abort", () => controller.abort());

    const timeout = setTimeout(() => controller.abort(), 180_000);

    try {
      this.outputChannel.appendLine(
        `[${new Date().toISOString()}] [research-llm] complete (${this.model}, ${userPrompt.length} chars)`,
      );
      const response = await fetch(ZAI_CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Accept-Language": "en-US,en",
        },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new ZaiApiError(
          `LLM call failed: ${text.slice(0, 300)}`,
          response.status,
          ZAI_CHAT_URL,
        );
      }

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? "";
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}
