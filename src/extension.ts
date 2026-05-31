import * as vscode from "vscode";

const VENDOR = "zai";
const SECRET_KEY = "zai.apiKey";
const API_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const CHAT_COMPLETIONS_URL = `${API_BASE_URL}/chat/completions`;
const MODELS_URL = `${API_BASE_URL}/models`;

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
  const provider = new ZaiProvider(context);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    vscode.commands.registerCommand("zai.manage", () => provider.manage()),
    vscode.commands.registerCommand("zai.diagnostics", () => provider.showDiagnostics()),
    vscode.commands.registerCommand("zai.setApiKey", () => provider.setApiKey())
  );
}

export function deactivate() {
  // Nothing to clean up.
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
        { label: "Refresh Models", action: "refresh" as const }
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

    this.log(`Request: model=${model.id} messages=${apiMessages.length}`);
    if (settings.debugReasoning) {
      this.log("Reasoning debug is enabled. Provider reasoning_content will be written to this output channel when available.");
    }

    try {
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
        this.getOutputChannel(),
        (toolCallIds, reasoningContent) => {
          for (const toolCallId of toolCallIds) {
            this.reasoningContentByToolCallId.set(toolCallId, reasoningContent);
          }
        }
      );
      this.log(`Request completed: model=${model.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`ERROR model=${model.id}: ${message}`);
      this.getOutputChannel().show(true);

      // Show a user-visible dialog with the actual API error
      vscode.window.showErrorMessage(`Z.AI request failed: ${message}`);

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
  onReasoningContent?: (toolCallIds: string[], reasoningContent: string) => void
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

  await streamZaiResponse(
    url,
    apiKey,
    requestBody,
    progress,
    token,
    settings,
    output,
    (data) => extractor.extractStreamParts(data),
    extractChatCompletionParts
  );
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
  extractFullParts: (data: unknown) => vscode.LanguageModelResponsePart[]
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
    if (token.isCancellationRequested) {
      throw new DOMException("Request cancelled", "AbortError");
    }

    if (attempt > 0) {
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      await doStreamFetch(url, apiKey, body, progress, token, settings, extractStreamParts, extractFullParts);
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

      output.appendLine(`Retry ${attempt + 1}/${settings.maxRetries} after error: ${lastError.message}`);
    }
  }

  throw lastError ?? new Error("Z.AI request failed after retries");
}

async function doStreamFetch(
  url: string,
  apiKey: string,
  body: unknown,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
  settings: ApiSettings,
  extractStreamParts: (data: unknown) => vscode.LanguageModelResponsePart[],
  extractFullParts: (data: unknown) => vscode.LanguageModelResponsePart[]
): Promise<void> {
  const controller = new AbortController();
  const cancellation = token.onCancellationRequested(() => controller.abort());

  // Apply request timeout: whichever fires first (user cancellation or timeout)
  const timeoutId = setTimeout(() => controller.abort(new DOMException(`Request timed out after ${settings.requestTimeout}ms`, "TimeoutError")), settings.requestTimeout);

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

    if (!response.ok) {
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
      const data = await response.json();
      for (const part of extractFullParts(data)) {
        progress.report(part);
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

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        for (const part of parseServerSentEvent(event, extractStreamParts)) {
          progress.report(part);
        }
      }
    }

    for (const part of parseServerSentEvent(buffer, extractStreamParts)) {
      progress.report(part);
    }
  } finally {
    clearTimeout(timeoutId);
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
  extractParts: (data: unknown) => vscode.LanguageModelResponsePart[]
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
  if (imageParts.length > 0) {
    const content: ApiContentPart[] = [];
    if (textParts.length > 0) {
      content.push({ type: "text", text: textParts.join("\n") });
    }
    content.push(...imageParts);

    if (role === "assistant" && toolCalls.length) {
      return [{
        role,
        content: content || null,
        reasoning_content: reasoningForToolCalls(toolCalls, reasoningContentByToolCallId),
        tool_calls: toolCalls
      }];
    }

    if (toolResults.length) {
      return [{ role, content }, ...toolResults];
    }

    return [{ role, content }];
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
