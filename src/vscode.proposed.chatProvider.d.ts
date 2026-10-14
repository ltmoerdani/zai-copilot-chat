/**
 * Local type augmentation for VS Code's per-model configuration options
 * (the "Thinking Effort" chips in the model picker details popup).
 *
 * These fields shipped to stable builds (the model picker renders them
 * natively — same mechanism the OpenCode extension uses) but the pinned
 * `@types/vscode` version for this extension does not declare them yet.
 * This mirrors OpenCode's `src/vscode.proposed.chatProvider.d.ts` shim
 * (contract version 6). When `@types/vscode` is bumped past the release
 * that declares these members natively, DELETE this file — conflicting
 * duplicate declarations would then error at compile time, which is the
 * intended signal.
 */
declare module "vscode" {
  /**
   * A JSON-schema-like description of the per-model configuration options
   * rendered by the model picker.
   */
  export interface LanguageModelConfigurationSchema {
    readonly type?: string;
    readonly properties?: Readonly<
      Record<
        string,
        Record<string, unknown> & {
          readonly enumItemLabels?: string[];
          readonly enumDescriptions?: string[];
          readonly group?: string;
        }
      >
    >;
  }

  export interface LanguageModelChatInformation {
    /** Per-model options shown in the model picker (Thinking Effort, …). */
    readonly configurationSchema?: LanguageModelConfigurationSchema;
  }

  export interface ProvideLanguageModelChatResponseOptions {
    /**
     * The user's per-model configuration, validated against the model's
     * `configurationSchema`, replayed into every chat request.
     */
    readonly modelConfiguration?: Readonly<Record<string, unknown>>;
  }
}
