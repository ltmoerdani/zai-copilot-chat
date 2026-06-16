/**
 * Z.AI Coding Plan quota utilities.
 *
 * Z.AI exposes quota information through the monitor endpoint:
 *   GET https://api.z.ai/api/monitor/usage/quota/limit
 *
 * Response shape (data field):
 *   {
 *     "level": "free" | "pro" | "enterprise",
 *     "limits": [
 *       {
 *         "type": "TOKENS_LIMIT" | "TIME_LIMIT",
 *         "unit": number,     // 3=hours, 5=months, 6=weeks
 *         "number": number,
 *         "percentage": number,   // 0-100 usage
 *         "nextResetTime": number // unix ms
 *         // TIME_LIMIT also has: usage, currentValue, remaining, usageDetails
 *       }
 *     ]
 *   }
 */

export type QuotaWindowUnit = "hour" | "week" | "month" | "unknown";

export interface QuotaWindow {
  /** Human-readable window name, e.g. "5-Hour", "1-Week". */
  windowName: string;
  /** Unit kind resolved from API numeric `unit`. */
  unit: QuotaWindowUnit;
  /** API numeric unit (3=hour, 5=month, 6=week). */
  unitCode: number;
  /** Quantity of the time unit (e.g. 5 for 5-Hour). */
  number: number;
  /** Usage percentage 0–100. */
  percentage: number;
  /** Unix ms when the window resets. */
  nextResetTime?: number;
}

export interface QuotaSnapshot {
  /** Detected plan level, e.g. "free", "pro", "enterprise". */
  planLevel?: string;
  /** Token quota windows (5-hour, weekly, etc.). */
  tokenQuotas: QuotaWindow[];
  /** MCP tool time limits. */
  timeLimits: QuotaWindow[];
  /** Timestamp the snapshot was captured. */
  capturedAt: number;
  /** Raw payload (for diagnostics). */
  raw?: unknown;
}

interface QuotaLimitApiResponse {
  level?: string;
  limits?: Array<{
    type?: "TOKENS_LIMIT" | "TIME_LIMIT" | string;
    unit?: number;
    number?: number;
    percentage?: number;
    nextResetTime?: number;
    usage?: number;
    currentValue?: number;
    remaining?: number;
    usageDetails?: Array<{ modelCode?: string; usage?: number }>;
  }>;
}

export function formatWindowName(unitCode: number | undefined, number: number | undefined): string {
  const names: Record<number, string> = { 3: "Hour", 5: "Month", 6: "Week" };
  const name = (unitCode !== undefined && names[unitCode]) ?? "Unknown";
  const qty = number ?? 1;
  return `${qty}-${name}${qty > 1 ? "s" : ""}`;
}

function resolveUnit(unitCode: number | undefined): QuotaWindowUnit {
  switch (unitCode) {
    case 3: return "hour";
    case 6: return "week";
    case 5: return "month";
    default: return "unknown";
  }
}

/**
 * Parse the response from `GET /api/monitor/usage/quota/limit`.
 * Accepts either the raw response or its `data` wrapper.
 */
export function parseQuotaSnapshot(payload: unknown): QuotaSnapshot {
  const root = (payload && typeof payload === "object" && "data" in payload
    ? (payload as { data: QuotaLimitApiResponse }).data
    : (payload as QuotaLimitApiResponse)) ?? {};

  const tokenQuotas: QuotaWindow[] = [];
  const timeLimits: QuotaWindow[] = [];

  for (const lim of root.limits ?? []) {
    const unitCode = lim.unit;
    const window: QuotaWindow = {
      windowName: formatWindowName(unitCode, lim.number),
      unit: resolveUnit(unitCode),
      unitCode: unitCode ?? -1,
      number: lim.number ?? 1,
      percentage: typeof lim.percentage === "number" ? lim.percentage : 0,
      nextResetTime: lim.nextResetTime,
    };

    if (lim.type === "TOKENS_LIMIT") {
      tokenQuotas.push(window);
    } else if (lim.type === "TIME_LIMIT") {
      timeLimits.push(window);
    }
  }

  return {
    planLevel: root.level,
    tokenQuotas,
    timeLimits,
    capturedAt: Date.now(),
    raw: payload,
  };
}

export function hasQuotaSnapshot(snapshot: QuotaSnapshot | undefined): snapshot is QuotaSnapshot {
  if (!snapshot) return false;
  return snapshot.tokenQuotas.length > 0 || snapshot.timeLimits.length > 0;
}

/** Pick the smallest hour-based window (typically 5-Hour). */
export function pickHourlyQuota(snapshot: QuotaSnapshot): QuotaWindow | undefined {
  const hourly = snapshot.tokenQuotas
    .filter((q) => q.unit === "hour")
    .sort((a, b) => a.number - b.number);
  if (hourly.length > 0) return hourly[0];
  // Fallback: smallest window overall
  return snapshot.tokenQuotas.slice().sort((a, b) => a.unitCode * a.number - b.unitCode * b.number)[0];
}

/** Pick the smallest week-based window. */
export function pickWeeklyQuota(snapshot: QuotaSnapshot): QuotaWindow | undefined {
  const weekly = snapshot.tokenQuotas
    .filter((q) => q.unit === "week")
    .sort((a, b) => a.number - b.number);
  if (weekly.length > 0) return weekly[0];
  return pickHourlyQuota(snapshot);
}

function clampPct(pct: number): number {
  return Math.max(0, Math.min(100, pct));
}

/** Pick a stroke color (hex) for a given usage percentage. */
function strokeForPct(pct: number): string {
  const clamped = clampPct(pct);
  if (clamped >= 95) return "#f48771"; // red
  if (clamped >= 80) return "#cca700"; // yellow
  return "#3794ff"; // blue
}

/**
 * Generates a compact, centered SVG donut chart with **two concentric
 * rings**: the outer ring represents the weekly quota, the inner ring the
 * 5-hour quota. Designed to take minimal screen space in a tooltip.
 */
export function quotaDonutSvg(
  hourlyPct: number | undefined,
  weeklyPct: number | undefined,
  options: { size?: number; hourlyLabel?: string; weeklyLabel?: string } = {},
): string {
  const size = options.size ?? 96;
  const center = size / 2;
  const stroke = 7;
  // Outer ring (weekly)
  const outerR = center - stroke / 2 - 1;
  // Inner ring (5h)
  const innerR = outerR - stroke - 3;
  const outerCircumference = 2 * Math.PI * outerR;
  const innerCircumference = 2 * Math.PI * innerR;

  const outerClamped = clampPct(weeklyPct ?? 0);
  const innerClamped = clampPct(hourlyPct ?? 0);
  const outerOffset = outerCircumference * (1 - outerClamped / 100);
  const innerOffset = innerCircumference * (1 - innerClamped / 100);
  const outerColor = strokeForPct(outerClamped);
  const innerColor = strokeForPct(innerClamped);

  const trackColor = "rgba(128,128,128,0.25)";

  const hourlyLabel = options.hourlyLabel ?? "5h";
  const weeklyLabel = options.weeklyLabel ?? "wk";
  const hourlyText = hourlyPct !== undefined ? `${Math.round(hourlyPct)}%` : "—";
  const weeklyText = weeklyPct !== undefined ? `${Math.round(weeklyPct)}%` : "—";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" font-family="sans-serif">
  <g transform="rotate(-90 ${center} ${center})">
    <circle cx="${center}" cy="${center}" r="${outerR}" fill="none" stroke="${trackColor}" stroke-width="${stroke}" />
    <circle cx="${center}" cy="${center}" r="${outerR}" fill="none" stroke="${outerColor}" stroke-width="${stroke}"
      stroke-dasharray="${outerCircumference.toFixed(2)}" stroke-dashoffset="${outerOffset.toFixed(2)}" stroke-linecap="round" />
    <circle cx="${center}" cy="${center}" r="${innerR}" fill="none" stroke="${trackColor}" stroke-width="${stroke}" />
    <circle cx="${center}" cy="${center}" r="${innerR}" fill="none" stroke="${innerColor}" stroke-width="${stroke}"
      stroke-dasharray="${innerCircumference.toFixed(2)}" stroke-dashoffset="${innerOffset.toFixed(2)}" stroke-linecap="round" />
  </g>
  <text x="${center}" y="${center - 1}" text-anchor="middle" dominant-baseline="central" font-size="15" font-weight="700" fill="currentColor">${hourlyText}</text>
  <text x="${center}" y="${center + 12}" text-anchor="middle" font-size="7" fill="currentColor" opacity="0.7">${hourlyLabel}</text>
</svg>`;
}

/** Encode an SVG string as a data URI suitable for `![alt](data:...)`. */
export function svgToDataUri(svg: string): string {
  const encoded = encodeURIComponent(svg)
    .replace(/'/g, "%27")
    .replace(/"/g, "%22");
  return `data:image/svg+xml;charset=utf-8,${encoded}`;
}

export function formatResetCountdown(nextResetTime: number | undefined, nowMs: number = Date.now()): string | undefined {
  if (nextResetTime === undefined) return undefined;
  const diffMs = nextResetTime - nowMs;
  if (diffMs <= 0) return "now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs > 0 ? `in ${days}d ${remHrs}h` : `in ${days}d`;
}

export function formatRelative(date: Date | number, nowMs: number = Date.now()): string {
  const ts = typeof date === "number" ? date : date.getTime();
  const diffMs = nowMs - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatPlanLabel(level: string | undefined): string {
  if (!level) return "";
  return level.charAt(0).toUpperCase() + level.slice(1).toLowerCase();
}

/**
 * Status bar text: "$(graph) Z · NN% of 5 Hours" style.
 */
export function formatQuotaStatusBarText(
  snapshot: QuotaSnapshot | undefined,
  viewMode: "hourly" | "weekly" = "hourly",
): string | undefined {
  if (!snapshot || !hasQuotaSnapshot(snapshot)) return undefined;

  const window = viewMode === "hourly" ? pickHourlyQuota(snapshot) : pickWeeklyQuota(snapshot);
  if (!window) return undefined;

  if (viewMode === "hourly") {
    return `$(graph) Z · ${Math.round(window.percentage)}% of ${window.number}h`;
  }
  return `$(graph) Z · ${Math.round(window.percentage)}% of week`;
}

/**
 * Markdown tooltip with a compact, centered dual-ring SVG donut chart.
 * Renders in VS Code's native status-bar hover tooltip.
 */
export function formatQuotaTooltip(snapshot: QuotaSnapshot | undefined): string {
  if (!snapshot || !hasQuotaSnapshot(snapshot)) {
    return "Z.AI quota not available. Click to refresh.";
  }

  const hourly = pickHourlyQuota(snapshot);
  const weekly = pickWeeklyQuota(snapshot);
  const hourlyPct = hourly?.percentage;
  const weeklyPct = weekly?.percentage;

  const svg = quotaDonutSvg(hourlyPct, weeklyPct, {
    hourlyLabel: "5h",
    weeklyLabel: "wk",
  });
  const dataUri = svgToDataUri(svg);

  const hourlyReset = hourly ? formatResetCountdown(hourly.nextResetTime, snapshot.capturedAt) : undefined;
  const weeklyReset = weekly ? formatResetCountdown(weekly.nextResetTime, snapshot.capturedAt) : undefined;

  const plan = formatPlanLabel(snapshot.planLevel);
  const title = plan ? `Z.AI ${plan} plan` : "Z.AI plan";

  const legendHourly = hourly
    ? `● 5h: ${Math.round(hourly.percentage)}%${hourlyReset ? ` (${hourlyReset})` : ""}`
    : "";
  const legendWeekly = weekly && weekly !== hourly
    ? `● wk: ${Math.round(weekly.percentage)}%${weeklyReset ? ` (${weeklyReset})` : ""}`
    : "";

  // Center the donut using an HTML table wrapper (reliable in VS Code tooltips)
  const centeredImg = `<div align="center"><img src="${dataUri}" width="96" height="96" /></div>`;
  const legend = [legendHourly, legendWeekly].filter(Boolean).join("  ·  ");

  const parts: string[] = [
    `**${title}**`,
    "",
    centeredImg,
    "",
    `<div align="center"><sub>${legend}</sub></div>`,
  ];

  if (snapshot.timeLimits.length > 0) {
    parts.push("");
    for (const tl of snapshot.timeLimits) {
      parts.push(`${tl.windowName} MCP: ${Math.round(tl.percentage)}%`);
    }
  }

  parts.push("");
  parts.push(`<sub>Updated ${formatRelative(snapshot.capturedAt)} · click to toggle</sub>`);
  return parts.join("\n");
}

export function formatQuotaLogLine(snapshot: QuotaSnapshot | undefined): string | undefined {
  if (!snapshot || !hasQuotaSnapshot(snapshot)) return undefined;
  const parts: string[] = [];
  for (const q of snapshot.tokenQuotas) {
    parts.push(`${q.windowName}=${Math.round(q.percentage)}%`);
  }
  return parts.length > 0 ? `[quota] ${parts.join(" ")}` : undefined;
}

/** Resolve API response to its `data` payload, regardless of shape. */
function unwrapData(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: unknown }).data;
  }
  return payload;
}

export interface QuotaFetchOptions {
  apiKey: string;
  /** Base URL — defaults to https://api.z.ai. */
  baseUrl?: string;
  /** Optional AbortSignal. */
  signal?: AbortSignal;
}

/**
 * Fetch the quota snapshot from Z.AI monitor endpoint.
 * Tries both `Bearer <key>` and raw `<key>` Authorization formats.
 */
export async function fetchQuotaSnapshot(opts: QuotaFetchOptions): Promise<QuotaSnapshot> {
  const baseUrl = (opts.baseUrl ?? "https://api.z.ai").replace(/\/$/, "");
  const url = `${baseUrl}/api/monitor/usage/quota/limit`;
  const headers: Record<string, string> = {
    "Accept-Language": "en-US,en",
    "Content-Type": "application/json",
  };

  const authFormats = [`Bearer ${opts.apiKey}`, opts.apiKey];
  let lastError: Error | undefined;

  for (const auth of authFormats) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { ...headers, Authorization: auth },
        signal: opts.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (response.status === 401 || response.status === 403) {
          lastError = new Error(`Auth failed (${response.status}): ${text}`);
          continue;
        }
        throw new Error(`Quota request failed (${response.status}): ${text}`);
      }

      const json = await response.json();
      return parseQuotaSnapshot(unwrapData(json));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Auth failed/.test(message)) {
        lastError = error instanceof Error ? error : new Error(message);
        continue;
      }
      throw error instanceof Error ? error : new Error(message);
    }
  }

  throw lastError ?? new Error("Quota request failed");
}
