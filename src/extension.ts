import * as vscode from "vscode";
import {
  clearContextWindowRequest,
  disposeContextWindowHookBridge,
  initializeContextWindowHookBridge,
  reportProgressWithContextWindowRequest,
  reportUsageToContextWindowForRequest,
  setContextWindowOutputBufferForRequest,
} from "./contextWindowHookBridge";
import { createUsageDataParts, isInternalDataPart } from "./chatParts";
import {
  formatCacheHitRatio,
  formatUsageLogLine,
  formatUsageStatusBarText,
  formatUsageStatusBarTooltip,
  type UsageSnapshot,
} from "./usage";
import {
  fetchQuotaSnapshot,
  formatQuotaLogLine,
  formatQuotaStatusBarText,
  formatQuotaTooltip,
  formatResetCountdown as resetCountdown,
  hasQuotaSnapshot,
  type QuotaSnapshot,
} from "./quota";

const VENDOR = "zai";
const SECRET_KEY = "zai.apiKey";
const API_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const CHAT_COMPLETIONS_URL = `${API_BASE_URL}/chat/completions`;
const MODELS_URL = `${API_BASE_URL}/models`;

let usageStatusBarItem: vscode.StatusBarItem | undefined;
let quotaStatusBarItem: vscode.StatusBarItem | undefined;
let lastQuotaSnapshot: QuotaSnapshot | undefined;
let quotaViewMode: "hourly" | "weekly" = "hourly";
let quotaRefreshTimer: ReturnType<typeof setInterval> | undefined;

type ApiRole = "user" | "assistant" | "tool";

interface ZaiModel extends vscode.LanguageModelChatInformation {
  endpointKind: "chat-completions";
}

interface ModelListResponse {
  data?: Array<{
    id?: string;
    owned_by?: string;
  }>;
}

interface ApiContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: string;
  };
}

interface ApiMessage {
  role: ApiRole;
  content: string | null | ApiContentPart[];
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ApiSettings {
  temperature: number;
  maxOutputTokensOverride: number;
  maxInputTokensOverride: number;
  debugReasoning: boolean;
  requestTimeout: number;
  maxRetries: number;
}

interface LanguageModelConfiguration {
  apiKey?: unknown;
}

type ConfiguredLanguageModelInfoOptions = vscode.PrepareLanguageModelChatModelOptions & {
  configuration?: LanguageModelConfiguration;
};

type ConfiguredLanguageModelResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  configuration?: LanguageModelConfiguration;
};

interface BaseModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

interface ModelLimits extends BaseModelLimits {
  advertisedContextWindow: number;
  advertisedMaxInputTokens: number;
  advertisedMaxOutputTokens: number;
}

// Budget reserved for model output when advertising input capacity to VS Code.
// VS Code uses (advertisedMaxInputTokens) to decide when to compact conversations.
// A smaller reserve means VS Code compacts sooner, preventing context overflow.
const OUTPUT_TOKEN_RESERVE = 16384;

const DEFAULT_MODEL_LIMITS: BaseModelLimits = {
  contextWindow: 128000,
  maxOutputTokens: 128000
};

// Context window and max output tokens from official Z.AI docs:
// https://docs.bigmodel.cn/cn/guide/start/model-overview
const MODEL_LIMITS: Record<string, BaseModelLimits> = {
  // Text models — 1M context
  "glm-5.2":        { contextWindow: 1000000, maxOutputTokens: 128000 },
  // Text models — 200K context
  "glm-5.1":        { contextWindow: 200000, maxOutputTokens: 128000 },
  "glm-5":          { contextWindow: 200000, maxOutputTokens: 128000 },
  "glm-5-turbo":    { contextWindow: 200000, maxOutputTokens: 128000 },
  "glm-4.7":        { contextWindow: 200000, maxOutputTokens: 128000 },
  "glm-4.7-flashx": { contextWindow: 200000, maxOutputTokens: 128000 },
  "glm-4.7-flash":  { contextWindow: 200000, maxOutputTokens: 128000 },
  "glm-4.6":        { contextWindow: 200000, maxOutputTokens: 128000 },
  // Text models — 128K context
  "glm-4.5":        { contextWindow: 128000, maxOutputTokens: 96000 },
  "glm-4.5-air":    { contextWindow: 128000, maxOutputTokens: 96000 },
  "glm-4.5-airx":   { contextWindow: 128000, maxOutputTokens: 96000 },
  "glm-4.5-flash":  { contextWindow: 128000, maxOutputTokens: 96000 },
  // Vision models
  "glm-5v-turbo":   { contextWindow: 200000, maxOutputTokens: 128000 },
  "glm-4.6v":       { contextWindow: 128000, maxOutputTokens: 32000 },
  "glm-4.6v-flash": { contextWindow: 128000, maxOutputTokens: 32000 },
};

const VISION_MODELS = new Set(["glm-5v-turbo", "glm-4.6v", "glm-4.6v-flash"]);

const BUNDLED_MODELS = [
  // Text models — 1M context
  "glm-5.2",
  // Text models — 200K
  "glm-5.1",
  "glm-5",
  "glm-5-turbo",
  "glm-4.7",
  "glm-4.6",
  // Text models — 128K
  "glm-4.5",
  "glm-4.5-air",
  "glm-4.5-airx",
  "glm-4.5-flash",
  // Vision models
  "glm-5v-turbo",
  "glm-4.6v",
  "glm-4.6v-flash"
];

type CopilotCompatibleCapabilities = vscode.LanguageModelChatCapabilities & {
  supportsToolCalling: boolean;
  supportsImageToText: boolean;
};

interface OpenAiToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export function activate(context: vscode.ExtensionContext) {
  ensureUsageStatusBar(context);
  ensureQuotaStatusBar(context);
  void syncExperimentalContextIndicator();

  const provider = new ZaiProvider(context);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    vscode.commands.registerCommand("zai.manage", () => provider.manage()),
    vscode.commands.registerCommand("zai.diagnostics", () => provider.showDiagnostics()),
    vscode.commands.registerCommand("zai.setApiKey", () => provider.setApiKey()),
    vscode.commands.registerCommand("zai.quota", () => provider.showQuota()),
    vscode.commands.registerCommand("zai.toggleQuotaView", () => {
      quotaViewMode = quotaViewMode === "hourly" ? "weekly" : "hourly";
      if (lastQuotaSnapshot) {
        updateQuotaStatusBar(lastQuotaSnapshot);
      } else {
        void provider.refreshQuotaFromSecret();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("zai.showUsageStatusBar")) {
        resetUsageStatusBar();
      }
      if (event.affectsConfiguration("zai.showQuotaStatusBar")) {
        resetQuotaStatusBar();
      }
      if (event.affectsConfiguration("zai.quotaRefreshInterval")) {
        setupQuotaRefreshTimer(context);
      }
      if (event.affectsConfiguration("zai.experimentalContextIndicator")) {
        void syncExperimentalContextIndicator();
      }
    }),
  );

  // Initial quota fetch + periodic refresh
  void provider.refreshQuotaFromSecret();
  setupQuotaRefreshTimer(context);
}

function setupQuotaRefreshTimer(context: vscode.ExtensionContext): void {
  if (quotaRefreshTimer) {
    clearInterval(quotaRefreshTimer);
    quotaRefreshTimer = undefined;
  }
  const intervalMinutes = vscode.workspace
    .getConfiguration("zai")
    .get("quotaRefreshInterval", 5);
  if (intervalMinutes <= 0) return;
  const provider = new ZaiProvider(context);
  quotaRefreshTimer = setInterval(() => {
    void provider.refreshQuotaFromSecret();
  }, intervalMinutes * 60_000);
}

export async function deactivate(): Promise<void> {
  await disposeContextWindowHookBridge();
}

function ensureUsageStatusBar(
  context: vscode.ExtensionContext,
): vscode.StatusBarItem {
  if (!usageStatusBarItem) {
    usageStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      95,
    );
    context.subscriptions.push(usageStatusBarItem);
  }

  resetUsageStatusBar();
  return usageStatusBarItem;
}

function shouldShowUsageStatusBar(): boolean {
  return vscode.workspace
    .getConfiguration("zai")
    .get("showUsageStatusBar", true);
}

function isExperimentalContextIndicatorEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("zai")
    .get("experimentalContextIndicator", false);
}

function resetUsageStatusBar(): void {
  if (!usageStatusBarItem) {
    return;
  }

  if (!shouldShowUsageStatusBar()) {
    usageStatusBarItem.hide();
    return;
  }

  usageStatusBarItem.text = "Z.AI";
  usageStatusBarItem.tooltip = "Z.AI usage summary";
  usageStatusBarItem.show();
}

function updateUsageStatusBar(
  providerDisplayName: string,
  modelId: string,
  summary: TransportRequestSummary,
): void {
  if (!usageStatusBarItem) {
    return;
  }

  if (!shouldShowUsageStatusBar()) {
    usageStatusBarItem.hide();
    return;
  }

  const usage: UsageSnapshot = {
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    totalTokens: summary.totalTokens,
    cachedTokens: summary.cachedTokens,
    finishReason: summary.finishReason,
  };
  const text = formatUsageStatusBarText(providerDisplayName, usage);

  usageStatusBarItem.text = text ?? providerDisplayName;
  usageStatusBarItem.tooltip = formatUsageStatusBarTooltip(
    providerDisplayName,
    modelId,
    usage,
  );
  usageStatusBarItem.show();
}

function ensureQuotaStatusBar(
  context: vscode.ExtensionContext,
): vscode.StatusBarItem | undefined {
  if (!quotaStatusBarItem) {
    quotaStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      94,
    );
    quotaStatusBarItem.command = "zai.toggleQuotaView";
    context.subscriptions.push(quotaStatusBarItem);
  }

  resetQuotaStatusBar();
  return quotaStatusBarItem;
}

function shouldShowQuotaStatusBar(): boolean {
  return vscode.workspace
    .getConfiguration("zai")
    .get("showQuotaStatusBar", true);
}

function resetQuotaStatusBar(): void {
  if (!quotaStatusBarItem) {
    return;
  }

  if (!shouldShowQuotaStatusBar()) {
    quotaStatusBarItem.hide();
    return;
  }

  const text = formatQuotaStatusBarText(lastQuotaSnapshot, quotaViewMode);
  if (!text) {
    quotaStatusBarItem.text = "$(graph) Z.AI quota";
    quotaStatusBarItem.tooltip = new vscode.MarkdownString(
      "Z.AI quota not available. Click to refresh.\n\nIf you have not set an API key yet, use 'Z.AI: Set API Key'.",
      true,
    );
    quotaStatusBarItem.tooltip.supportHtml = true;
    quotaStatusBarItem.tooltip.isTrusted = true;
    quotaStatusBarItem.backgroundColor = undefined;
    quotaStatusBarItem.show();
    return;
  }

  quotaStatusBarItem.text = text;
  const tooltip = new vscode.MarkdownString(formatQuotaTooltip(lastQuotaSnapshot), true);
  tooltip.supportHtml = true;
  tooltip.isTrusted = true;
  quotaStatusBarItem.tooltip = tooltip;
  quotaStatusBarItem.show();
}

function updateQuotaStatusBar(snapshot: QuotaSnapshot): void {
  lastQuotaSnapshot = snapshot;

  if (!quotaStatusBarItem) {
    return;
  }

  if (!shouldShowQuotaStatusBar()) {
    quotaStatusBarItem.hide();
    return;
  }

  const text = formatQuotaStatusBarText(snapshot, quotaViewMode);
  if (!text) {
    resetQuotaStatusBar();
    return;
  }

  quotaStatusBarItem.text = text;
  const tooltip = new vscode.MarkdownString(formatQuotaTooltip(snapshot), true);
  tooltip.supportHtml = true;
  tooltip.isTrusted = true;
  quotaStatusBarItem.tooltip = tooltip;

  // Color warnings based on the active view's percentage
  const window = quotaViewMode === "hourly"
    ? snapshot.tokenQuotas.find((q) => q.unit === "hour")
    : snapshot.tokenQuotas.find((q) => q.unit === "week");
  const pct = window?.percentage ?? 0;
  if (pct >= 95) {
    quotaStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (pct >= 80) {
    quotaStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    quotaStatusBarItem.backgroundColor = undefined;
  }

  quotaStatusBarItem.show();
}

export function getLastQuotaSnapshot(): QuotaSnapshot | undefined {
  return lastQuotaSnapshot;
}

let hookDiagnosticChannel: vscode.OutputChannel | undefined;

function getHookDiagnosticChannel(): vscode.OutputChannel {
  if (!hookDiagnosticChannel) {
    hookDiagnosticChannel = vscode.window.createOutputChannel("Z.AI");
  }
  return hookDiagnosticChannel;
}

function hookDiagnostic(message: string): void {
  getHookDiagnosticChannel().appendLine(
    `[${new Date().toISOString()}] [contextWindowHook] ${message}`,
  );
}

async function syncExperimentalContextIndicator(): Promise<void> {
  if (isExperimentalContextIndicatorEnabled()) {
    const ok = await initializeContextWindowHookBridge(hookDiagnostic);
    if (!ok) {
      hookDiagnostic(
        "experimentalContextIndicator is enabled but the bridge could not activate. " +
        "The Copilot Chat footer will show default (estimated) usage. " +
        "This is expected if VS Code internals changed — check for extension updates.",
      );
    }
    return;
  }

  await disposeContextWindowHookBridge();
}

interface TransportRequestSummary {
  modelId: string;
  status?: number;
  durationMs: number;
  totalBytes: number;
  totalEvents: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  finishReason?: string;
  abortedReason?: string;
  errorMessage?: string;
}

class ZaiProvider implements vscode.LanguageModelChatProvider<ZaiModel> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
  private readonly apiKeysByModelId = new Map<string, string>();
  private readonly reasoningContentByToolCallId = new Map<string, string>();
  private outputChannel: vscode.OutputChannel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext
  ) {}

  private getOutputChannel(): vscode.OutputChannel {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel("Z.AI");
      this.context.subscriptions.push(this.outputChannel);
    }
    return this.outputChannel;
  }

  private log(message: string): void {
    this.getOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  async manage(): Promise<void> {
    const apiKey = await this.context.secrets.get(SECRET_KEY);

    if (!apiKey) {
      await this.setApiKey();
      return;
    }

    const choice = await vscode.window.showQuickPick(
      [
        { label: "Set API Key", action: "set" as const },
        { label: "Clear API Key", action: "clear" as const },
        { label: "Test Connection", action: "test" as const },
        { label: "Refresh Models", action: "refresh" as const },
        { label: "Show Quota", action: "quota" as const }
      ],
      {
        title: "Manage Z.AI",
        placeHolder: "Choose an action"
      }
    );

    if (!choice) {
      return;
    }

    if (choice.action === "set") {
      await this.setApiKey();
      return;
    }

    if (choice.action === "clear") {
      await this.context.secrets.delete(SECRET_KEY);
      this.changeEmitter.fire();
      vscode.window.showInformationMessage("Z.AI API key cleared.");
      return;
    }

    if (choice.action === "test") {
      await this.testConnection();
      return;
    }

    if (choice.action === "quota") {
      await this.showQuota();
      return;
    }

    this.changeEmitter.fire();
    vscode.window.showInformationMessage("Z.AI models refreshed.");
  }

  async testConnection(): Promise<void> {
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    if (!apiKey) {
      vscode.window.showErrorMessage("Z.AI: No API key set. Use 'Set API Key' first.");
      return;
    }

    const statusBar = vscode.window.setStatusBarMessage(`$(loading~spin) Testing Z.AI connection...`);
    this.log(`Testing connection to ${CHAT_COMPLETIONS_URL}`);

    try {
      const response = await fetch(CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "glm-4.7",
          messages: [{ role: "user", content: "reply with just: ok" }],
          max_tokens: 10,
          stream: false
        })
      });

      const responseText = await response.text();
      statusBar.dispose();
      this.log(`Test response (${response.status}): ${responseText}`);
      this.getOutputChannel().show(true);

      if (response.ok) {
        vscode.window.showInformationMessage(`Z.AI: Connection OK (HTTP ${response.status}). Check Output panel for details.`);
      } else {
        vscode.window.showErrorMessage(`Z.AI: Connection failed (HTTP ${response.status}). Check Output panel for details.`);
      }
    } catch (error) {
      statusBar.dispose();
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Test connection error: ${message}`);
      this.getOutputChannel().show(true);
      vscode.window.showErrorMessage(`Z.AI: Connection error - ${message}`);
    }
  }

  async setApiKey(): Promise<void> {
    const apiKey = await vscode.window.showInputBox({
      title: "Z.AI API Key",
      prompt: "Paste your Z.AI API key. It will be stored securely in VS Code SecretStorage.",
      password: true,
      ignoreFocusOut: true
    });

    if (!apiKey) {
      return;
    }

    await this.context.secrets.store(SECRET_KEY, apiKey.trim());
    this.changeEmitter.fire();
    vscode.window.showInformationMessage("Z.AI API key saved.");
  }

  async showDiagnostics(): Promise<void> {
    const models = await vscode.lm.selectChatModels({ vendor: VENDOR });
    const lines = models.map((model) => {
      const limits = modelLimits(model.id);
      return [
      `- ${model.id}`,
      `  name: ${model.name}`,
      `  family: ${model.family}`,
      `  vendor: ${model.vendor}`,
      `  version: ${model.version}`,
      `  maxInputTokens: ${model.maxInputTokens}`,
      `  advertisedMaxOutputTokens: ${limits.advertisedMaxOutputTokens}`,
      `  advertisedContextWindow: ${limits.advertisedContextWindow}`,
      `  apiMaxOutputTokens: ${limits.maxOutputTokens}`,
      ...(MODEL_LIMITS[model.id] ? [] : ["  limits: using default fallback"])
      ].join("\n");
    });

    const content = [
      "# Z.AI Diagnostics",
      "",
      `Models visible through vscode.lm.selectChatModels({ vendor: "zai" }): ${models.length}`,
      "",
      ...lines
    ].join("\n");

    const doc = await vscode.workspace.openTextDocument({ content, language: "markdown" });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  async showQuota(): Promise<void> {
    const snapshot = lastQuotaSnapshot;
    const apiKey = await this.context.secrets.get(SECRET_KEY);

    // Try to refresh quota proactively if we have a key but no snapshot yet.
    if (apiKey && (!snapshot || !hasQuotaSnapshot(snapshot))) {
      const statusBar = vscode.window.setStatusBarMessage(`$(loading~spin) Refreshing Z.AI quota...`);
      try {
        await this.refreshQuota(apiKey);
      } finally {
        statusBar.dispose();
      }
    }

    if (!apiKey) {
      const choice = await vscode.window.showWarningMessage(
        "Z.AI: No API key set. Configure an API key to view Coding Plan quota.",
        "Set API Key",
      );
      if (choice === "Set API Key") {
        await this.setApiKey();
      }
      return;
    }

    const current = lastQuotaSnapshot;
    if (!current || !hasQuotaSnapshot(current)) {
      vscode.window.showInformationMessage(
        "Z.AI: Could not retrieve Coding Plan quota. " +
        "Check the Z.AI management dashboard (z.ai/manage/quota) for authoritative numbers.",
      );
      return;
    }

    const plan = current.planLevel
      ? ` (${current.planLevel.charAt(0).toUpperCase()}${current.planLevel.slice(1).toLowerCase()} plan)`
      : "";
    const lines: string[] = [`# Z.AI Coding Plan quota${plan}`, ""];

    for (const q of current.tokenQuotas) {
      lines.push(`## ${q.windowName}`);
      lines.push(`- Usage: ${Math.round(q.percentage)}%`);
      const reset = resetCountdown(q.nextResetTime, current.capturedAt);
      if (reset) lines.push(`- Resets in: ${reset}`);
      lines.push("");
    }

    if (current.timeLimits.length > 0) {
      lines.push("## MCP tool limits");
      for (const tl of current.timeLimits) {
        lines.push(`- ${tl.windowName}: ${Math.round(tl.percentage)}%`);
      }
      lines.push("");
    }

    lines.push(`_Captured: ${new Date(current.capturedAt).toISOString()}_`);

    const doc = await vscode.workspace.openTextDocument({
      content: lines.join("\n"),
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  /** Refresh quota using API key from SecretStorage. */
  async refreshQuotaFromSecret(): Promise<QuotaSnapshot | undefined> {
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    if (!apiKey) {
      return undefined;
    }
    return this.refreshQuota(apiKey);
  }

  /**
   * Fetches the current Coding Plan quota from the Z.AI monitor endpoint.
   */
  async refreshQuota(apiKey: string): Promise<QuotaSnapshot | undefined> {
    try {
      const snapshot = await fetchQuotaSnapshot({ apiKey });
      updateQuotaStatusBar(snapshot);
      this.log(`Refreshed quota: ${formatQuotaLogLine(snapshot) ?? "(no fields)"}`);
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Quota refresh failed: ${message}`);
      return undefined;
    }
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<ZaiModel[]> {
    const apiKey = getConfiguredApiKey(options as ConfiguredLanguageModelInfoOptions);

    if (!apiKey) {
      return [];
    }

    if (token.isCancellationRequested) {
      return [];
    }

    const models = await this.fetchModels(apiKey);
    const settings = getSettings();

    return models.map((modelId) => {
      const limits = modelLimits(modelId, settings);
      this.apiKeysByModelId.set(modelId, apiKey);

      return {
        id: modelId,
        name: `Z.AI / ${formatModelName(modelId)}`,
        family: `zai-${modelId}`,
        version: "1.0.0",
        detail: "Z.AI",
        tooltip: `Z.AI model: ${modelId}`,
        category: {
          label: "Z.AI",
          order: 2
        },
        isUserSelectable: true,
        maxInputTokens: limits.advertisedMaxInputTokens,
        maxOutputTokens: limits.advertisedMaxOutputTokens,
        capabilities: modelCapabilities(modelId),
        endpointKind: "chat-completions"
      };
    });
  }

  async provideLanguageModelChatResponse(
    model: ZaiModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const apiKey =
      getConfiguredApiKey(options as ConfiguredLanguageModelResponseOptions)
      ?? this.apiKeysByModelId.get(model.id);

    if (!apiKey) {
      throw new Error("Z.AI API key is required. Use the Z.AI gear icon in Language Models to configure it, then reload the window.");
    }

    const apiMessages = normalizeMessages(messages.flatMap((message) => convertMessage(message, this.reasoningContentByToolCallId)));
    const settings = getSettings();
    const limits = modelLimits(model.id, settings);
    const localRequestId = crypto.randomUUID();

    this.log(`Request: model=${model.id} messages=${apiMessages.length}`);
    if (settings.debugReasoning) {
      this.log("Reasoning debug is enabled. Provider reasoning_content will be written to this output channel when available.");
    }

    try {
      const outputChannel = this.getOutputChannel();

      // Estimate the output buffer for context window tracking
      const estimatedInputTokens = estimateTotalTokens(apiMessages);
      const maxAvailableOutput = Math.max(1024, limits.contextWindow - estimatedInputTokens);
      const contextWindowOutputBuffer = Math.min(limits.maxOutputTokens, maxAvailableOutput);

      await streamChatCompletions(
        CHAT_COMPLETIONS_URL,
        apiKey,
        model.id,
        apiMessages,
        options,
        settings,
        limits,
        progress,
        token,
        outputChannel,
        (toolCallIds, reasoningContent) => {
          for (const toolCallId of toolCallIds) {
            this.reasoningContentByToolCallId.set(toolCallId, reasoningContent);
          }
        },
        localRequestId,
        contextWindowOutputBuffer,
        (summary) => {
          updateUsageStatusBar("Z.AI", model.id, summary);
          const usageLog = formatUsageLogLine({
            promptTokens: summary.promptTokens,
            completionTokens: summary.completionTokens,
            totalTokens: summary.totalTokens,
            cachedTokens: summary.cachedTokens,
            finishReason: summary.finishReason,
          });
          if (usageLog) {
            outputChannel.appendLine(`[usage] ${usageLog}`);
          }
        },
      );
      this.log(`Request completed: model=${model.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = message.includes("timed out") || message.includes("Timeout") || message.includes("inactive");
      const isFlagship = (MODEL_LIMITS[model.id]?.contextWindow ?? 0) >= 200000;
      const friendlyMsg = isTimeout
        ? `Z.AI request to ${model.id} timed out. ${isFlagship
            ? `glm-5.2 / glm-5.1 / glm-5 / glm-4.7 are large-context flagship models (200K–1M) and need longer timeouts (default 3 min, inactivity 90-180s).`
            : ``
          } Try: (1) retry — Z.AI servers may be under load, (2) increase \`zai.requestTimeout\` in Settings (max 300000ms), (3) try a smaller/faster model like \`glm-4.5-flash\`, or (4) clear chat history to reduce context size. Detail: ${message}`
        : `Z.AI request failed: ${message}`;
      this.log(`ERROR model=${model.id}: ${message}`);
      this.getOutputChannel().show(true);

      // Show a user-visible dialog with the actual API error
      vscode.window.showErrorMessage(friendlyMsg);

      throw error;
    }
  }

  async provideTokenCount(
    _model: ZaiModel,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const value = typeof text === "string" ? text : messageText(text);
    return estimateTokenCount(value);
  }

  private async fetchModels(apiKey: string): Promise<string[]> {
    try {
      const response = await fetch(MODELS_URL, {
        headers: {
          "Authorization": `Bearer ${apiKey}`
        }
      });

      if (!response.ok) {
        // 401/403: models endpoint may be restricted — silently use bundled list
        if (response.status === 401 || response.status === 403) {
          this.log(`Model list endpoint returned ${response.status}, using bundled fallback`);
          return [...BUNDLED_MODELS];
        }
        throw new Error(`Model list request failed (${response.status}): ${response.statusText}`);
      }

      const data = await response.json() as ModelListResponse;
      const apiIds = data.data
        ?.map((model) => model.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);

      // Merge API models with bundled models to ensure vision models always appear
      const mergedIds = new Set([...(apiIds ?? []), ...BUNDLED_MODELS]);
      return Array.from(mergedIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showWarningMessage(`Could not fetch Z.AI model list. Using bundled model list. ${message}`);
      return BUNDLED_MODELS;
    }
  }

}

function getConfiguredApiKey(options?: { configuration?: LanguageModelConfiguration }): string | undefined {
  const configuredApiKey = options?.configuration?.apiKey;
  return typeof configuredApiKey === "string" && configuredApiKey.trim() ? configuredApiKey.trim() : undefined;
}

interface RequestUsageSummary {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  finishReason?: string;
}

async function streamChatCompletions(
  url: string,
  apiKey: string,
  modelId: string,
  messages: ApiMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  settings: ApiSettings,
  limits: ModelLimits,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
  onReasoningContent?: (toolCallIds: string[], reasoningContent: string) => void,
  localRequestId?: string,
  contextWindowOutputBuffer?: number,
  onTransportSummary?: (summary: TransportRequestSummary) => void,
): Promise<void> {
  const tools = mapOpenAiTools(options.tools);
  const extractor = new OpenAiResponseExtractor(onReasoningContent, (reasoningContent) => {
    if (settings.debugReasoning) {
      output.appendLine("[reasoning_content]");
      output.appendLine(reasoningContent);
      output.appendLine("[/reasoning_content]");
    }
  });

  // Estimate input token usage to budget max_tokens appropriately.
  // This prevents sending a request where input + max_tokens > context window.
  const estimatedInputTokens = estimateTotalTokens(messages);
  const maxAvailableOutput = Math.max(1024, limits.contextWindow - estimatedInputTokens);
  const requestMaxTokens = Math.min(limits.maxOutputTokens, maxAvailableOutput);

  const requestBody: Record<string, unknown> = {
    model: modelId,
    messages,
    temperature: settings.temperature,
    max_tokens: requestMaxTokens,
    stream: true,
    ...(tools.length ? { tools, tool_choice: toolChoice(options.toolMode) } : {})
  };

  // Z.AI GLM models need thinking disabled to return normal text content
  if (modelId.startsWith("glm-")) {
    requestBody.thinking = { type: "disabled" };
  }

  output.appendLine(`[${new Date().toISOString()}] Token budget: model=${modelId} input≈${estimatedInputTokens} maxOut=${requestMaxTokens} (contextWindow=${limits.contextWindow}, budgetUsed=${estimatedInputTokens + requestMaxTokens})`);

  if (estimatedInputTokens >= limits.contextWindow) {
    output.appendLine(`[${new Date().toISOString()}] WARNING: Input tokens (${estimatedInputTokens}) >= context window (${limits.contextWindow}). Request may fail.`);
  }

  const startedAt = Date.now();
  const usageSummary: RequestUsageSummary = {};

  await streamZaiResponse(
    url,
    apiKey,
    requestBody,
    progress,
    token,
    settings,
    output,
    (data) => extractor.extractStreamParts(data),
    extractChatCompletionParts,
    (data) => updateRequestUsageSummary(usageSummary, data),
    localRequestId,
    contextWindowOutputBuffer,
  );

  const durationMs = Date.now() - startedAt;
  const summary: TransportRequestSummary = {
    modelId,
    durationMs,
    totalBytes: 0, // Not tracked in current implementation
    totalEvents: 0,
    ...(usageSummary.promptTokens === undefined
      ? {}
      : { promptTokens: usageSummary.promptTokens }),
    ...(usageSummary.completionTokens === undefined
      ? {}
      : { completionTokens: usageSummary.completionTokens }),
    ...(usageSummary.totalTokens === undefined
      ? {}
      : { totalTokens: usageSummary.totalTokens }),
    ...(usageSummary.cachedTokens === undefined
      ? {}
      : { cachedTokens: usageSummary.cachedTokens }),
    ...(usageSummary.finishReason === undefined
      ? {}
      : { finishReason: usageSummary.finishReason }),
  };

  output.appendLine(
    `[response-summary] model=${modelId} durationMs=${durationMs} promptTokens=${usageSummary.promptTokens ?? "n/a"} completionTokens=${usageSummary.completionTokens ?? "n/a"} totalTokens=${usageSummary.totalTokens ?? "n/a"} cachedTokens=${usageSummary.cachedTokens ?? "n/a"} finishReason=${usageSummary.finishReason ?? "<unknown>"}`,
  );

  const usageLog = formatUsageLogLine({
    promptTokens: usageSummary.promptTokens,
    completionTokens: usageSummary.completionTokens,
    totalTokens: usageSummary.totalTokens,
    cachedTokens: usageSummary.cachedTokens,
    finishReason: usageSummary.finishReason,
  });
  if (usageLog) {
    output.appendLine(`[usage] ${usageLog}`);
  }

  onTransportSummary?.(summary);

  if (localRequestId) {
    reportUsageToContextWindowForRequest(localRequestId, {
      promptTokens: usageSummary.promptTokens,
      completionTokens: usageSummary.completionTokens,
      totalTokens: usageSummary.totalTokens,
      cachedTokens: usageSummary.cachedTokens,
      finishReason: usageSummary.finishReason,
    });
  }

  const usageParts =
    summary.errorMessage || summary.abortedReason
      ? []
      : createUsageDataParts({
          promptTokens: usageSummary.promptTokens,
          completionTokens: usageSummary.completionTokens,
          totalTokens: usageSummary.totalTokens,
          cachedTokens: usageSummary.cachedTokens,
          finishReason: usageSummary.finishReason,
        });
  for (const usagePart of usageParts) {
    if (localRequestId) {
      reportProgressWithContextWindowRequest(localRequestId, progress, usagePart);
    } else {
      progress.report(usagePart);
    }
  }

  if (localRequestId) {
    clearContextWindowRequest(localRequestId);
  }
}

function estimateTotalTokens(messages: ApiMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += estimateTokenCount(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          total += estimateTokenCount(part.text);
        }
      }
    }
    // Tool calls and reasoning content also consume tokens
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += estimateTokenCount(tc.function.name) + estimateTokenCount(tc.function.arguments);
      }
    }
    if (msg.reasoning_content) {
      total += estimateTokenCount(msg.reasoning_content);
    }
  }
  return total;
}

function mapOpenAiTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): OpenAiToolDefinition[] {
  return (tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? { type: "object", properties: {} }
    }
  }));
}

function toolChoice(mode: vscode.LanguageModelChatToolMode): "auto" | "required" {
  return mode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto";
}

async function streamZaiResponse(
  url: string,
  apiKey: string,
  body: unknown,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
  settings: ApiSettings,
  output: vscode.OutputChannel,
  extractStreamParts: (data: unknown) => vscode.LanguageModelResponsePart[],
  extractFullParts: (data: unknown) => vscode.LanguageModelResponsePart[],
  onUsageData?: (data: unknown) => void,
  localRequestId?: string,
  contextWindowOutputBuffer?: number,
): Promise<void> {
  let lastError: Error | undefined;
  const maxAttempts = 1 + settings.maxRetries; // 1 initial + N retries

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (token.isCancellationRequested) {
      throw new DOMException("Request cancelled", "AbortError");
    }

    if (attempt > 0) {
      // Exponential backoff with jitter to avoid thundering herd
      const baseDelay = Math.min(1000 * 2 ** (attempt - 1), 10000);
      const jitter = Math.random() * 500;
      const delay = baseDelay + jitter;
      output.appendLine(`Retry ${attempt}/${settings.maxRetries} in ${Math.round(delay)}ms after error: ${lastError?.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      await doStreamFetch(url, apiKey, body, progress, token, settings, extractStreamParts, extractFullParts, output, onUsageData, localRequestId, contextWindowOutputBuffer);
      return; // success
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on cancellation or non-retryable HTTP errors
      if (lastError.name === "AbortError" || isNonRetryableHttpError(lastError)) {
        throw lastError;
      }

      // Only retry on network-level errors or 5xx/429
      if (!isRetryableError(lastError)) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error(`Z.AI request failed after ${settings.maxRetries} retries`);
}

async function doStreamFetch(
  url: string,
  apiKey: string,
  body: unknown,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
  settings: ApiSettings,
  extractStreamParts: (data: unknown) => vscode.LanguageModelResponsePart[],
  extractFullParts: (data: unknown) => vscode.LanguageModelResponsePart[],
  output: vscode.OutputChannel,
  onUsageData?: (data: unknown) => void,
  localRequestId?: string,
  contextWindowOutputBuffer?: number,
): Promise<void> {
  const controller = new AbortController();
  const cancellation = token.onCancellationRequested(() => controller.abort());

  // Per-model timeout scaling.
  // Flagship large-context models (glm-5.2 at 1M, glm-5.1/glm-5/glm-5-turbo/glm-4.7 at 200K) have
  // longer cold-start and per-token latency — they need a more generous
  // inactivity threshold. Use a 1.5x multiplier for 200K+ models, 1x otherwise.
  const modelId = typeof body === "object" && body !== null && "model" in body
    ? String((body as { model: unknown }).model ?? "")
    : "";
  const limits = MODEL_LIMITS[modelId];
  const isFlagshipModel = limits !== undefined && limits.contextWindow >= 200000;
  const modelTimeoutMultiplier = isFlagshipModel ? 1.5 : 1.0;
  const effectiveConnectionTimeout = Math.min(
    300000,
    Math.round(settings.requestTimeout * modelTimeoutMultiplier)
  );

  output.appendLine(
    `[${new Date().toISOString()}] Timeout config: model=${modelId || "?"} ` +
    `flagship=${isFlagshipModel} multiplier=${modelTimeoutMultiplier}× ` +
    `connectionTimeout=${effectiveConnectionTimeout}ms ` +
    `(base=${settings.requestTimeout}ms, max=300000ms)`
  );

  // Connection timeout: abort if the initial connection / headers take too long.
  // This is separate from the inactivity timeout below.
  const connectionTimeoutId = setTimeout(
    () => controller.abort(new DOMException(`Connection timed out after ${effectiveConnectionTimeout}ms`, "TimeoutError")),
    effectiveConnectionTimeout
  );

  // Track the last time we received data, for inactivity detection.
  let lastActivity = Date.now();
  // Inactivity timeout: if no data arrives for this long during streaming, abort.
  // Minimum 90s (so flagship models with slow first-token latency don't get
  // killed mid-stream), max 180s, and scaled by the same model multiplier.
  const baseInactivityMs = Math.max(90000, Math.min(180000, settings.requestTimeout / 2));
  const inactivityMs = Math.min(180000, Math.round(baseInactivityMs * modelTimeoutMultiplier));
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

  const resetInactivity = () => {
    lastActivity = Date.now();
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
    }
    inactivityTimer = setTimeout(() => {
      const inactiveFor = Date.now() - lastActivity;
      output.appendLine(`Inactivity timeout: no data for ${inactiveFor}ms (threshold: ${inactivityMs}ms)`);
      controller.abort(new DOMException(`Stream inactive for ${Math.round(inactiveFor / 1000)}s — Z.AI server stopped sending data`, "TimeoutError"));
    }, inactivityMs);
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    // Connection succeeded — clear connection timeout, start inactivity timer
    clearTimeout(connectionTimeoutId);
    resetInactivity();

    if (!response.ok) {
      // Clear inactivity timer on error path
      if (inactivityTimer) { clearTimeout(inactivityTimer); }
      const detail = await response.text();
      const code = parseApiErrorCode(detail);
      // 429 with subscription errors — give a helpful hint
      if (response.status === 429 && code === "1311") {
        throw new Error(
          `Z.AI API request failed (429): ${detail}\n\nHint: This model may not be included in your current plan. Check your Z.AI subscription dashboard and verify the model is enabled.`
        );
      }
      throw new Error(`Z.AI API request failed (${response.status}): ${detail || response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) {
      if (inactivityTimer) { clearTimeout(inactivityTimer); }
      const data = await response.json();
      onUsageData?.(data);
      for (const part of extractFullParts(data)) {
        if (localRequestId) {
          reportProgressWithContextWindowRequest(localRequestId, progress, part);
        } else {
          progress.report(part);
        }
      }
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!token.isCancellationRequested) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      // Data received — reset inactivity timer
      resetInactivity();

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        for (const part of parseServerSentEvent(event, extractStreamParts, onUsageData)) {
          if (localRequestId) {
            reportProgressWithContextWindowRequest(localRequestId, progress, part);
          } else {
            progress.report(part);
          }
        }
      }
    }

    if (inactivityTimer) { clearTimeout(inactivityTimer); }

    for (const part of parseServerSentEvent(buffer, extractStreamParts, onUsageData)) {
      if (localRequestId) {
        reportProgressWithContextWindowRequest(localRequestId, progress, part);
      } else {
        progress.report(part);
      }
    }
  } finally {
    clearTimeout(connectionTimeoutId);
    if (inactivityTimer) { clearTimeout(inactivityTimer); }
    cancellation.dispose();
  }
}

function isRetryableError(error: Error): boolean {
  // Network-level errors (fetch failed, DNS, connection refused, timeout)
  if (error.message.includes("fetch failed") || error.name === "TypeError") {
    return true;
  }
  // Timeout errors from our AbortSignal.timeout
  if (error.name === "TimeoutError") {
    return true;
  }
  // 5xx server errors and 429 rate limits
  if (/\(5\d{2}\)/.test(error.message) || error.message.includes("429")) {
    return true;
  }
  return false;
}

function isNonRetryableHttpError(error: Error): boolean {
  // 4xx client errors (except 429) should not be retried
  return /\(4[0-8]\d\)/.test(error.message) || /\(400\)/.test(error.message);
}

function parseServerSentEvent(
  event: string,
  extractParts: (data: unknown) => vscode.LanguageModelResponsePart[],
  onData?: (data: unknown) => void,
): vscode.LanguageModelResponsePart[] {
  const lines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());

  const parts: vscode.LanguageModelResponsePart[] = [];

  for (const line of lines) {
    if (!line || line === "[DONE]") {
      continue;
    }

    try {
      const data = JSON.parse(line) as unknown;
      onData?.(data);
      parts.push(...extractParts(data));
    } catch {
      // Ignore malformed SSE lines; the API may send comments or keep-alive frames.
    }
  }

  return parts;
}

function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < data.length; i += chunkSize) {
    binary += String.fromCharCode(...data.subarray(i, Math.min(i + chunkSize, data.length)));
  }
  return btoa(binary);
}

function convertMessage(
  message: vscode.LanguageModelChatRequestMessage,
  reasoningContentByToolCallId: ReadonlyMap<string, string>
): ApiMessage[] {
  const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user";
  const textParts: string[] = [];
  const imageParts: ApiContentPart[] = [];
  const toolCalls: OpenAiToolCall[] = [];
  const toolResults: ApiMessage[] = [];

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelToolCallPart) {
      toolCalls.push({
        id: part.callId,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input ?? {})
        }
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      toolResults.push({
        role: "tool",
        tool_call_id: part.callId,
        content: part.content.map(partToText).filter(Boolean).join("\n")
      });
      continue;
    }

    // Handle image data parts from Copilot
    if (part instanceof vscode.LanguageModelDataPart) {
      const base64 = uint8ArrayToBase64(part.data);
      const mime = part.mimeType || "image/png";
      imageParts.push({
        type: "image_url",
        image_url: {
          url: `data:${mime};base64,${base64}`,
          detail: "auto"
        }
      });
      continue;
    }

    const text = partToText(part);
    if (text) {
      textParts.push(text);
    }
  }

  // If there are images, build content as an array (OpenAI vision format)
  // NOTE: Z.AI only accepts type:"text" — strip image_url parts to avoid
  // "messages.content.type is invalid, allowed values: ['text']" errors.
  if (imageParts.length > 0) {
    const content: ApiContentPart[] = [];
    if (textParts.length > 0) {
      content.push({ type: "text", text: textParts.join("\n") });
    }
    // imageParts intentionally omitted — Z.AI API rejects image_url content type.
    // If images were the only content, fall through to use the text-only path below.

    // Only use array content if we actually have multiple text parts;
    // otherwise use plain string for maximum API compatibility.
    const effectiveContent: string | ApiContentPart[] | null =
      content.length === 0 ? null
      : content.length === 1 && content[0].type === "text" ? (content[0].text ?? "")
      : content;

    if (role === "assistant" && toolCalls.length) {
      return [{
        role,
        content: effectiveContent,
        reasoning_content: reasoningForToolCalls(toolCalls, reasoningContentByToolCallId),
        tool_calls: toolCalls
      }];
    }

    if (toolResults.length) {
      return [{ role, content: effectiveContent }, ...toolResults];
    }

    return [{ role, content: effectiveContent }];
  }

  const content = textParts.join("\n");

  if (role === "assistant" && toolCalls.length) {
    return [{
      role,
      content: content || null,
      reasoning_content: reasoningForToolCalls(toolCalls, reasoningContentByToolCallId),
      tool_calls: toolCalls
    }];
  }

  if (toolResults.length) {
    return content ? [{ role, content }, ...toolResults] : toolResults;
  }

  return [{ role, content }];
}

function reasoningForToolCalls(
  toolCalls: OpenAiToolCall[],
  reasoningContentByToolCallId: ReadonlyMap<string, string>
): string | undefined {
  const reasoning = toolCalls
    .map((toolCall) => reasoningContentByToolCallId.get(toolCall.id))
    .filter((value): value is string => Boolean(value?.trim()));

  return reasoning.length ? reasoning.join("\n") : undefined;
}

function updateRequestUsageSummary(
  summary: RequestUsageSummary,
  data: unknown,
): void {
  if (!isRecord(data)) {
    return;
  }

  const usage = isRecord(data.usage) ? data.usage : undefined;
  if (usage) {
    const promptTokens =
      typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
    const completionTokens =
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : undefined;
    const totalTokens =
      typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
    const promptTokenDetails = isRecord(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : undefined;
    const cachedTokens =
      promptTokenDetails &&
      typeof promptTokenDetails.cached_tokens === "number"
        ? promptTokenDetails.cached_tokens
        : undefined;

    if (promptTokens !== undefined) {
      summary.promptTokens = promptTokens;
    }
    if (completionTokens !== undefined) {
      summary.completionTokens = completionTokens;
    }
    if (totalTokens !== undefined) {
      summary.totalTokens = totalTokens;
    }
    if (cachedTokens !== undefined) {
      summary.cachedTokens = cachedTokens;
    }
  }

  const firstChoice =
    Array.isArray(data.choices) && isRecord(data.choices[0])
      ? data.choices[0]
      : undefined;
  if (firstChoice && typeof firstChoice.finish_reason === "string") {
    summary.finishReason = firstChoice.finish_reason;
  }
}

function messageText(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content.map(partToText).filter(Boolean).join("\n");
}

function partToText(part: vscode.LanguageModelInputPart | unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    return part.content.map(partToText).filter(Boolean).join("\n");
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return `[Tool call: ${part.name} ${JSON.stringify(part.input)}]`;
  }

  if (typeof part === "string") {
    return part;
  }

  return "";
}

function normalizeMessages(messages: ApiMessage[]): ApiMessage[] {
  const normalized: ApiMessage[] = [];

  for (const message of messages) {
    if (!hasMessagePayload(message)) {
      continue;
    }

    const previous = normalized.at(-1);
    const canMerge = previous?.role === message.role
      && message.role !== "tool"
      && !previous.tool_calls
      && !message.tool_calls
      && typeof previous.content === "string"
      && typeof message.content === "string";
    if (canMerge) {
      previous.content = `${previous.content ?? ""}\n\n${message.content ?? ""}`.trim();
    } else {
      normalized.push({ ...message });
    }
  }

  if (normalized[0]?.role === "assistant") {
    normalized.unshift({
      role: "user",
      content: "Continue the conversation based on the prior assistant message."
    });
  }

  return normalized.length ? normalized : [{ role: "user", content: "" }];
}

function hasMessagePayload(message: ApiMessage): boolean {
  if (message.tool_calls?.length || message.tool_call_id) {
    return true;
  }

  if (Array.isArray(message.content)) {
    return message.content.length > 0;
  }

  return typeof message.content === "string" && message.content.trim().length > 0;
}

class OpenAiResponseExtractor {
  private readonly pendingToolCalls = new Map<number, PendingToolCall>();
  private reasoningContent = "";

  constructor(
    private readonly onReasoningContent?: (toolCallIds: string[], reasoningContent: string) => void,
    private readonly onReasoningDebug?: (reasoningContent: string) => void
  ) {}

  extractStreamParts(data: unknown): vscode.LanguageModelResponsePart[] {
    if (!isRecord(data) || !Array.isArray(data.choices)) {
      return [];
    }

    const first = data.choices[0];
    if (!isRecord(first)) {
      return [];
    }

    const parts: vscode.LanguageModelResponsePart[] = [];
    const delta = first.delta;
    if (isRecord(delta)) {
      if (typeof delta.content === "string") {
        parts.push(new vscode.LanguageModelTextPart(delta.content));
      }
      if (typeof delta.reasoning_content === "string") {
        this.reasoningContent += delta.reasoning_content;
      }
      this.collectOpenAiToolCalls(delta.tool_calls);
    }

    if (first.finish_reason === "tool_calls") {
      parts.push(...this.flushToolCalls());
    }

    return parts;
  }

  private collectOpenAiToolCalls(toolCalls: unknown): void {
    if (!Array.isArray(toolCalls)) {
      return;
    }

    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) {
        continue;
      }

      const index = typeof toolCall.index === "number" ? toolCall.index : this.pendingToolCalls.size;
      const pending = this.pendingToolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof toolCall.id === "string") {
        pending.id = toolCall.id;
      }

      const fn = toolCall.function;
      if (isRecord(fn)) {
        if (typeof fn.name === "string") {
          pending.name += fn.name;
        }
        if (typeof fn.arguments === "string") {
          pending.arguments += fn.arguments;
        }
      }

      this.pendingToolCalls.set(index, pending);
    }
  }

  private flushToolCalls(): vscode.LanguageModelToolCallPart[] {
    const toolCalls = Array.from(this.pendingToolCalls.values())
      .filter((toolCall) => toolCall.name);
    const parts = toolCalls
      .map((toolCall, index) => new vscode.LanguageModelToolCallPart(
        toolCall.id || `zai-tool-${Date.now()}-${index}`,
        toolCall.name,
        parseToolInput(toolCall.arguments)
      ));

    if (this.reasoningContent.trim()) {
      this.onReasoningDebug?.(this.reasoningContent);
      this.onReasoningContent?.(parts.map((part) => part.callId), this.reasoningContent);
    }

    this.pendingToolCalls.clear();
    this.reasoningContent = "";
    return parts;
  }
}

function extractChatCompletionParts(data: unknown): vscode.LanguageModelResponsePart[] {
  if (!isRecord(data) || !Array.isArray(data.choices)) {
    return [];
  }

  const first = data.choices[0];
  if (!isRecord(first)) {
    return [];
  }

  const parts: vscode.LanguageModelResponsePart[] = [];
  const message = first.message;
  if (isRecord(message)) {
    if (typeof message.content === "string") {
      parts.push(new vscode.LanguageModelTextPart(message.content));
    }
    for (const toolCallPart of toolCallPartsFromOpenAiMessage(message.tool_calls, typeof message.reasoning_content === "string" ? message.reasoning_content : undefined)) {
      parts.push(toolCallPart);
    }
  }

  if (typeof first.text === "string") {
    parts.push(new vscode.LanguageModelTextPart(first.text));
  }

  return parts;
}

function toolCallPartsFromOpenAiMessage(toolCalls: unknown, _reasoningContent?: string): vscode.LanguageModelToolCallPart[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .filter(isRecord)
    .map((toolCall, index) => {
      const fn = toolCall.function;
      const id = typeof toolCall.id === "string" ? toolCall.id : `zai-tool-${Date.now()}-${index}`;
      const name = isRecord(fn) && typeof fn.name === "string" ? fn.name : "";
      const args = isRecord(fn) && typeof fn.arguments === "string" ? fn.arguments : "{}";
      return name ? new vscode.LanguageModelToolCallPart(id, name, parseToolInput(args)) : undefined;
    })
    .filter((part): part is vscode.LanguageModelToolCallPart => Boolean(part));
}

function parseToolInput(value: string): object {
  if (!value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getSettings(): ApiSettings {
  const config = vscode.workspace.getConfiguration("zai");

  return {
    temperature: config.get("temperature", 0.2),
    maxOutputTokensOverride: config.get("maxTokens", 0),
    maxInputTokensOverride: config.get("maxInputTokens", 0),
    debugReasoning: config.get("debugReasoning", false),
    requestTimeout: config.get("requestTimeout", 120000),
    maxRetries: config.get("maxRetries", 2)
  };
}

function modelLimits(modelId: string, settings = getSettings()): ModelLimits {
  const limits = MODEL_LIMITS[modelId] ?? DEFAULT_MODEL_LIMITS;
  const contextWindow = positiveOverride(settings.maxInputTokensOverride) ?? limits.contextWindow;
  const maxOutputTokens = positiveOverride(settings.maxOutputTokensOverride) ?? limits.maxOutputTokens;

  // The context window is the TOTAL token budget (input + output).
  // Advertised max input = context window minus a reserve for output.
  // This tells VS Code when to start compacting the conversation.
  const outputReserve = Math.min(maxOutputTokens, OUTPUT_TOKEN_RESERVE);
  const advertisedMaxInputTokens = Math.max(1, contextWindow - outputReserve);
  const advertisedMaxOutputTokens = Math.max(1, outputReserve);

  return {
    contextWindow,
    maxOutputTokens: Math.min(maxOutputTokens, contextWindow),
    advertisedContextWindow: contextWindow,
    advertisedMaxInputTokens,
    advertisedMaxOutputTokens
  };
}

function estimateTokenCount(value: string): number {
  if (!value) {
    return 0;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return 0;
  }

  const cjkCharacters = normalized.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const words = normalized.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/gu)?.length ?? 0;
  const charEstimate = Math.ceil(normalized.length / 4);

  return Math.max(1, Math.ceil(Math.max(words * 1.15, charEstimate, cjkCharacters)));
}

function positiveOverride(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function modelCapabilities(modelId?: string): CopilotCompatibleCapabilities {
  const isVision = modelId ? VISION_MODELS.has(modelId) : false;

  return {
    imageInput: isVision,
    toolCalling: 128,
    supportsImageToText: isVision,
    supportsToolCalling: true
  };
}

function parseApiErrorCode(detail: string): string | undefined {
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    if (parsed?.error && typeof parsed.error === "object") {
      const err = parsed.error as Record<string, unknown>;
      return typeof err.code === "string" ? err.code : undefined;
    }
  } catch {
    // Not JSON, ignore
  }
  return undefined;
}

function formatModelName(modelId: string): string {
  return modelId
    .split("-")
    .map((part) => part.toUpperCase() === part ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
