import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  QuotaAuthError,
  escapeMarkdown,
  fetchQuotaSnapshot,
  formatResetCountdown,
  formatWindowName,
  isQuotaAuthError,
  parseQuotaSnapshot,
  pickHourlyQuota,
  pickWeeklyQuota,
  quotaDonutSvg,
} from "../quota.js";

test("formatWindowName: handles known units and pluralization", () => {
  assert.equal(formatWindowName(3, 5), "5-Hours");
  assert.equal(formatWindowName(3, 1), "1-Hour");
  assert.equal(formatWindowName(6, 1), "1-Week");
  assert.equal(formatWindowName(5, 3), "3-Months");
  assert.equal(formatWindowName(3, undefined), "1-Hour");
});

test("parseQuotaSnapshot: accepts data-wrapped payloads", () => {
  const snapshot = parseQuotaSnapshot({
    data: {
      level: "pro",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 42.5, nextResetTime: 1_000 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 10 },
        { type: "TIME_LIMIT", unit: 6, number: 1, percentage: 7 },
      ],
    },
  });

  assert.equal(snapshot.planLevel, "pro");
  assert.equal(snapshot.tokenQuotas.length, 2);
  assert.equal(snapshot.timeLimits.length, 1);

  const hourly = pickHourlyQuota(snapshot);
  assert.equal(hourly?.unit, "hour");
  assert.equal(hourly?.number, 5);
  assert.equal(hourly?.percentage, 42.5);
  assert.equal(hourly?.windowName, "5-Hours");
  assert.equal(hourly?.nextResetTime, 1_000);

  const weekly = pickWeeklyQuota(snapshot);
  assert.equal(weekly?.unit, "week");
  assert.equal(weekly?.percentage, 10);
});

test("parseQuotaSnapshot: accepts raw payloads without `data` wrapper", () => {
  const snapshot = parseQuotaSnapshot({
    level: "free",
    limits: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 0 }],
  });
  assert.equal(snapshot.planLevel, "free");
  assert.equal(snapshot.tokenQuotas.length, 1);
  assert.equal(snapshot.timeLimits.length, 0);
});

test("parseQuotaSnapshot: tolerates malformed/empty payloads", () => {
  assert.deepEqual(
    { ...parseQuotaSnapshot(undefined), raw: undefined },
    { planLevel: undefined, tokenQuotas: [], timeLimits: [], capturedAt: parseQuotaSnapshot(undefined).capturedAt, raw: undefined },
  );
  const empty = parseQuotaSnapshot({});
  assert.equal(empty.tokenQuotas.length, 0);
  assert.equal(empty.timeLimits.length, 0);

  // Limits missing numeric fields fall back to safe defaults.
  const partial = parseQuotaSnapshot({ limits: [{ type: "TOKENS_LIMIT" }] });
  assert.equal(partial.tokenQuotas[0].percentage, 0);
  assert.equal(partial.tokenQuotas[0].number, 1);
  assert.equal(partial.tokenQuotas[0].unitCode, -1);
  assert.equal(partial.tokenQuotas[0].unit, "unknown");
});

test("formatResetCountdown: formats remaining time buckets", () => {
  const now = 1_700_000_000_000;
  assert.equal(formatResetCountdown(now, now), "now");
  assert.equal(formatResetCountdown(now - 1, now), "now"); // already passed
  assert.equal(formatResetCountdown(now + 5 * 60_000, now), "in 5m");
  assert.equal(formatResetCountdown(now + 59 * 60_000, now), "in 59m");
  assert.equal(formatResetCountdown(now + 90 * 60_000, now), "in 1h 30m");
  assert.equal(formatResetCountdown(now + 25 * 3600_000, now), "in 1d 1h");
  assert.equal(formatResetCountdown(now + 48 * 3600_000, now), "in 2d");
  assert.equal(formatResetCountdown(undefined, now), undefined);
});

test("quotaDonutSvg: produces a valid SVG with clamped percentages", () => {
  const svg = quotaDonutSvg(50, 75);
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /width="96"/);
  // The hourly percentage is rendered as the central text label.
  assert.match(svg, /50%/);
  // Weekly percentage is encoded in the outer-ring stroke geometry, not text.
  // Higher usage => smaller stroke-dashoffset. With 75% the outer offset
  // (1 - 0.75 = 0.25 of circumference) must be smaller than the inner offset
  // (1 - 0.50 = 0.50 of circumference).
  const offsets = [...svg.matchAll(/stroke-dashoffset="([\d.]+)"/g)].map((m) => parseFloat(m[1]));
  assert.ok(offsets.length >= 2, "should have inner + outer ring offsets");
  const [outerOffset, innerOffset] = offsets;
  assert.ok(outerOffset < innerOffset, "outer (75%) offset should be smaller than inner (50%)");

  // Over-limit percentages are clamped to 100% (offset becomes ~0).
  const over = quotaDonutSvg(150, 999, { size: 48 });
  assert.match(over, /width="48"/);
  const overOffsets = [...over.matchAll(/stroke-dashoffset="([\d.]+)"/g)].map((m) => parseFloat(m[1]));
  assert.ok(overOffsets.every((o) => o < 1), "clamped 100% should produce near-zero offsets");
});

test("quotaDonutSvg: default text color is light gray (legible on dark backgrounds)", () => {
  const svg = quotaDonutSvg(50, 75);
  // The chart is rendered as an embedded image, so it cannot inherit
  // `currentColor`. The default must be an explicit light color so it stays
  // visible against dark-theme tooltip backgrounds.
  assert.match(svg, /fill="#e8e8e8"/);
  assert.doesNotMatch(svg, /fill="currentColor"/);
});

test("quotaDonutSvg: textColor option overrides the default", () => {
  const svg = quotaDonutSvg(10, 20, { textColor: "#123abc" });
  assert.match(svg, /fill="#123abc"/);
});

test("quotaDonutSvg: undefined percentages render em-dash placeholders", () => {
  const svg = quotaDonutSvg(undefined, undefined);
  assert.match(svg, />—</);
});

test("escapeMarkdown: escapes core punctuation and leaves plain text intact", () => {
  assert.equal(escapeMarkdown("Pro"), "Pro");
  assert.equal(escapeMarkdown(""), "");
  assert.equal(escapeMarkdown(undefined), "");
  assert.equal(escapeMarkdown("a*b_c"), "a\\*b\\_c");
  assert.equal(escapeMarkdown("5-Hours"), "5\\-Hours");
  assert.equal(escapeMarkdown("evil`code`"), "evil\\`code\\`");
  assert.equal(escapeMarkdown("[x](y)"), "\\[x\\]\\(y\\)");
  assert.equal(escapeMarkdown("# h1 > x"), "\\# h1 \\> x");
});

test("QuotaAuthError: is detectable via instanceof and isQuotaAuthError", () => {
  const err = new QuotaAuthError("Auth failed (401): bad token", 401);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof QuotaAuthError);
  assert.ok(isQuotaAuthError(err));
  assert.equal(err.status, 401);
  assert.equal(err.name, "QuotaAuthError");

  // Plain errors must not be misclassified.
  assert.ok(!isQuotaAuthError(new Error("Auth failed (401)")));
  assert.ok(!isQuotaAuthError("Auth failed"));
});

test("fetchQuotaSnapshot: retries both auth formats on 401 then surfaces QuotaAuthError", async () => {
  let calls = 0;
  const fetchCalls: string[] = [];

  const fakeFetch = async (_url: string, init: { headers: Record<string, string> }) => {
    calls += 1;
    fetchCalls.push(init.headers.Authorization);
    return {
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    };
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch as unknown as typeof fetch;

  try {
    await assert.rejects(
      () => fetchQuotaSnapshot({ apiKey: "k" }),
      (err: unknown) => err instanceof QuotaAuthError && err.status === 401,
    );
    assert.equal(calls, 2, "should try both Bearer and raw auth formats");
    assert.deepEqual(fetchCalls, ["Bearer k", "k"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchQuotaSnapshot: succeeds on second auth format and parses snapshot", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 403, text: async () => "Forbidden" };
    }
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ data: { level: "enterprise", limits: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 3 }] } }),
    };
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch as unknown as typeof fetch;

  try {
    const snap = await fetchQuotaSnapshot({ apiKey: "key" });
    assert.equal(calls, 2);
    assert.equal(snap.planLevel, "enterprise");
    assert.equal(pickWeeklyQuota(snap)?.percentage, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchQuotaSnapshot: non-auth HTTP errors bubble up immediately", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return { ok: false, status: 500, text: async () => "boom" };
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch as unknown as typeof fetch;

  try {
    await assert.rejects(
      () => fetchQuotaSnapshot({ apiKey: "k" }),
      (err: unknown) => err instanceof Error && /500/.test(err.message) && !(err instanceof QuotaAuthError),
    );
    assert.equal(calls, 1, "should not retry on non-auth errors");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
