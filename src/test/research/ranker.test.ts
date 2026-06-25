/**
 * Unit tests for the research ranker: dedupe + BM25-style scoring.
 *
 * Pattern follows `quota.test.ts`: node:test + node:assert, no VS Code runtime.
 * Imports compiled JS (`.js`) to match the project's test runner.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  Ranker,
  normalizeUrlForDedupe,
} from "../../research/ranker.js";
import type { ResearchSource } from "../../research/types.js";

test("normalizeUrlForDedupe: strips protocol, trailing slash, lowercases host", () => {
  assert.equal(
    normalizeUrlForDedupe("HTTPS://Example.COM/Path/"),
    "example.com/Path",
  );
  assert.equal(
    normalizeUrlForDedupe("https://example.com/a?x=1"),
    "example.com/a?x=1",
  );
  assert.equal(
    normalizeUrlForDedupe("not-a-url"),
    "not-a-url",
  );
});

test("Ranker.add: dedupes by normalized URL, keeps higher score", () => {
  const ranker = new Ranker("GLM coding models", { maxKeep: 10 });

  const result = ranker.add([
    {
      url: "https://example.com/article",
      title: "GLM coding models",
      content: "GLM coding models are great",
      score: 0.5,
      discoveredByQuery: "q1",
    },
    {
      // Same URL with trailing slash — should dedupe.
      url: "https://example.com/article/",
      title: "GLM coding models (updated)",
      content: "GLM coding models are great",
      score: 0.8,
      discoveredByQuery: "q2",
    },
  ]);

  assert.equal(result.added, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(ranker.size, 1);

  const top = ranker.topK();
  assert.equal(top[0].score, 0.8);
  // The first sighting's query is preserved.
  assert.equal(top[0].discoveredByQuery, "q1");
});

test("Ranker.topK: returns up to maxKeep sorted by score descending", () => {
  const ranker = new Ranker("topic", { maxKeep: 3 });
  const sources: ResearchSource[] = [1, 2, 3, 4, 5].map((n) => ({
    url: `https://example.com/${n}`,
    title: `title ${n}`,
    content: "",
    score: n / 10,
  }));
  ranker.add(sources);

  const top = ranker.topK();
  assert.equal(top.length, 3);
  assert.deepEqual(
    top.map((s: ResearchSource) => s.score),
    [0.5, 0.4, 0.3],
  );
});

test("Ranker.scoreCandidate: rewards topic term overlap and recent years", () => {
  const ranker = new Ranker("GLM coding models benchmark", { maxKeep: 10 });

  const relevant = ranker.scoreCandidate({
    title: "GLM coding models benchmark results",
    snippet: "GLM coding models benchmark 2026",
  });
  const irrelevant = ranker.scoreCandidate({
    title: "unrelated weather report",
    snippet: "sunny skies today",
  });

  assert.ok(relevant > 0, "relevant candidate should score > 0");
  assert.ok(relevant > irrelevant, "relevant should beat irrelevant");
  assert.equal(irrelevant, 0, "no overlap → 0 score");
});

test("Ranker.scoreCandidate: applies recency boost for current year", () => {
  // Use a topic with a rare keyword so overlap stays below 1.0, leaving
  // headroom for the +0.1 recency boost to actually matter.
  const ranker = new Ranker("zephyrtronix", { maxKeep: 10 });
  const currentYear = new Date().getFullYear();

  const withYear = ranker.scoreCandidate({
    title: `zephyrtronix ${currentYear}`,
    snippet: "",
  });
  const withoutYear = ranker.scoreCandidate({
    title: "zephyrtronix",
    snippet: "",
  });

  // Both overlap on the single topic term → overlapScore = 1.0, but only
  // the year variant gets the +0.1 boost (capped at 1.0). To make the test
  // meaningful we instead assert the boost alone: build a candidate with
  // NO overlap so only recency can lift it above 0.
  const noOverlapWithYear = ranker.scoreCandidate({
    title: `nothing relevant ${currentYear}`,
    snippet: "",
  });
  const noOverlapWithoutYear = ranker.scoreCandidate({
    title: "nothing relevant",
    snippet: "",
  });

  assert.ok(
    noOverlapWithYear > noOverlapWithoutYear,
    "recent-year mention should lift a no-overlap candidate above 0",
  );
  assert.equal(noOverlapWithoutYear, 0, "no overlap + no year → 0");
});

test("Ranker.scoreCandidate: down-weights English + Indonesian stopwords", () => {
  const ranker = new Ranker("the dan untuk a with", { maxKeep: 10 });
  // All topic tokens are stopwords → term frequency index is empty → score 0.
  const score = ranker.scoreCandidate({
    title: "the dan untuk a with",
    snippet: "",
  });
  assert.equal(score, 0, "stopword-only topic should produce 0 score");
});
