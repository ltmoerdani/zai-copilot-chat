/**
 * Pure type definitions for the modlens CLI output contract (schema v2).
 *
 * Source of truth: https://github.com/liustack/modlens/blob/main/docs/output-schema.md
 *
 * Design notes:
 * - Every field is optional in our types even when modlens marks it required.
 *   modlens validates its own output server-side and fails over on broken
 *   results, but schema drift between CLI versions must never crash the chat
 *   request — unknown/missing fields degrade gracefully instead.
 * - Per the v2 contract, optional fields are ABSENT when empty, never `null`.
 *   Our guards therefore check `typeof === "string"` etc., not truthiness of
 *   nullable objects.
 *
 * This module must stay free of `vscode` imports so it can be unit-tested
 * with the plain Node test runner (see test/vision/*.test.ts).
 */

/** A single OCR line extracted from the image. `language` is optional. */
export interface ModlensOcrLine {
  text?: string;
  language?: string;
}

export interface ModlensOcr {
  full_text?: string;
  lines?: ModlensOcrLine[];
}

/** Layout region. `type` is an open string set (title, paragraph, table, chart, ...). */
export interface ModlensRegion {
  type?: string;
  reading_order?: number;
  text?: string;
}

export interface ModlensLayout {
  regions?: ModlensRegion[];
}

export interface ModlensEntity {
  name?: string;
  type?: string;
  evidence?: string;
}

export interface ModlensRelation {
  subject?: string;
  predicate?: string;
  object?: string;
}

export interface ModlensSemantics {
  scene?: string;
  intent?: string;
  entities?: ModlensEntity[];
  relations?: ModlensRelation[];
}

export interface ModlensVisual {
  dominant_colors?: string[];
  style?: string;
  notes?: string[];
}

/** The six required top-level fields of the v2 result object. */
export interface ModlensResult {
  summary?: string;
  ocr?: ModlensOcr;
  layout?: ModlensLayout;
  semantics?: ModlensSemantics;
  visual?: ModlensVisual;
  uncertainty?: string[];
}

export interface ModlensAttempt {
  provider?: string;
  ok?: boolean;
  durationSeconds?: number;
  error?: string;
}

export interface ModlensMeta {
  generatedAt?: string;
  /** `null` when the provider ran an unnamed model — hence `| null`. */
  model?: string | null;
  durationSeconds?: number;
  usage?: unknown;
  attempts?: ModlensAttempt[];
  warnings?: string[];
}

/** The single JSON object modlens prints to stdout. */
export interface ModlensOutput {
  image?: string;
  provider?: string;
  result?: ModlensResult;
  meta?: ModlensMeta;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}

/**
 * Narrow `unknown` (e.g. `JSON.parse` output) to `ModlensOutput`.
 *
 * Acceptance bar: a parsed object that has a `result` field which is itself a
 * plain object. Anything else (error payloads, plain text, `null`) is rejected
 * so the caller can surface a failure notice instead of injecting garbage.
 */
export function isModlensOutput(value: unknown): value is ModlensOutput {
  if (!isRecord(value)) {
    return false;
  }
  return isRecord(value.result);
}

/**
 * Best-effort normalization of a parsed object into a `ModlensResult`,
 * tolerating schema drift: unknown fields are ignored, mistyped optional
 * fields are dropped rather than crashing the caller.
 */
export function normalizeModlensResult(value: unknown): ModlensResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const result: ModlensResult = {};

  const summary = optionalString(value.summary);
  if (summary !== undefined) {
    result.summary = summary;
  }

  if (isRecord(value.ocr)) {
    const ocr: ModlensOcr = {};
    const fullText = optionalString(value.ocr.full_text);
    if (fullText !== undefined) {
      ocr.full_text = fullText;
    }
    if (Array.isArray(value.ocr.lines)) {
      const lines: ModlensOcrLine[] = [];
      for (const line of value.ocr.lines) {
        if (!isRecord(line)) {
          continue;
        }
        const text = optionalString(line.text);
        if (text === undefined) {
          continue;
        }
        const language = optionalString(line.language);
        lines.push(language === undefined ? { text } : { text, language });
      }
      if (lines.length > 0) {
        ocr.lines = lines;
      }
    }
    if (ocr.full_text !== undefined || ocr.lines !== undefined) {
      result.ocr = ocr;
    }
  }

  if (isRecord(value.layout) && Array.isArray(value.layout.regions)) {
    const regions: ModlensRegion[] = [];
    for (const region of value.layout.regions) {
      if (!isRecord(region)) {
        continue;
      }
      const type = optionalString(region.type);
      const text = optionalString(region.text);
      const readingOrder =
        typeof region.reading_order === "number" && Number.isFinite(region.reading_order)
          ? region.reading_order
          : undefined;
      // Keep regions that carry any usable signal; a region with neither type
      // nor text tells the model nothing.
      if (type === undefined && text === undefined) {
        continue;
      }
      regions.push({
        ...(type !== undefined ? { type } : {}),
        ...(readingOrder !== undefined ? { reading_order: readingOrder } : {}),
        ...(text !== undefined ? { text } : {}),
      });
    }
    if (regions.length > 0) {
      result.layout = { regions };
    }
  }

  if (isRecord(value.semantics)) {
    const semantics: ModlensSemantics = {};
    const scene = optionalString(value.semantics.scene);
    if (scene !== undefined) {
      semantics.scene = scene;
    }
    const intent = optionalString(value.semantics.intent);
    if (intent !== undefined) {
      semantics.intent = intent;
    }
    if (Array.isArray(value.semantics.entities)) {
      const entities: ModlensEntity[] = [];
      for (const entity of value.semantics.entities) {
        if (!isRecord(entity)) {
          continue;
        }
        const name = optionalString(entity.name);
        if (name === undefined) {
          continue;
        }
        const type = optionalString(entity.type);
        const evidence = optionalString(entity.evidence);
        entities.push({
          name,
          ...(type !== undefined ? { type } : {}),
          ...(evidence !== undefined ? { evidence } : {}),
        });
      }
      if (entities.length > 0) {
        semantics.entities = entities;
      }
    }
    if (Array.isArray(value.semantics.relations)) {
      const relations: ModlensRelation[] = [];
      for (const relation of value.semantics.relations) {
        if (!isRecord(relation)) {
          continue;
        }
        const subject = optionalString(relation.subject);
        const predicate = optionalString(relation.predicate);
        const object = optionalString(relation.object);
        if (subject === undefined && predicate === undefined && object === undefined) {
          continue;
        }
        relations.push({
          ...(subject !== undefined ? { subject } : {}),
          ...(predicate !== undefined ? { predicate } : {}),
          ...(object !== undefined ? { object } : {}),
        });
      }
      if (relations.length > 0) {
        semantics.relations = relations;
      }
    }
    if (
      semantics.scene !== undefined ||
      semantics.intent !== undefined ||
      semantics.entities !== undefined ||
      semantics.relations !== undefined
    ) {
      result.semantics = semantics;
    }
  }

  if (isRecord(value.visual)) {
    const visual: ModlensVisual = {};
    const colors = optionalStringArray(value.visual.dominant_colors);
    if (colors !== undefined) {
      visual.dominant_colors = colors;
    }
    const style = optionalString(value.visual.style);
    if (style !== undefined) {
      visual.style = style;
    }
    const notes = optionalStringArray(value.visual.notes);
    if (notes !== undefined) {
      visual.notes = notes;
    }
    if (
      visual.dominant_colors !== undefined ||
      visual.style !== undefined ||
      visual.notes !== undefined
    ) {
      result.visual = visual;
    }
  }

  const uncertainty = optionalStringArray(value.uncertainty);
  if (uncertainty !== undefined) {
    result.uncertainty = uncertainty;
  }

  return result;
}

/**
 * Human-readable engine label for logs and the evidence header,
 * e.g. `gemini-api/gemini-3.6-flash` or just `antigravity-cli`.
 */
export function describeModlensEngine(output: ModlensOutput): string {
  const provider = optionalString(output.provider) ?? "unknown-provider";
  const model = output.meta?.model;
  if (typeof model === "string" && model.length > 0) {
    return `${provider}/${model}`;
  }
  return provider;
}
