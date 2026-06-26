/**
 * Unit tests for the junk URL filter.
 *
 * The Z.AI Web Search often returns social media reels, YouTube links,
 * and site homepages. These either timeout (Instagram, TikTok) or
 * contain no useful content. Filtering them at the candidate stage
 * saves 30s webRead timeouts per junk URL.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isJunkUrl } from "../../research/junkUrlFilter.js";

test("isJunkUrl: Instagram /p/ and /reel/ paths are junk", () => {
  assert.equal(isJunkUrl("https://www.instagram.com/p/DYBZsfKkaf-/"), true);
  assert.equal(isJunkUrl("https://instagram.com/reel/DTo92rgk4i7/"), true);
});

test("isJunkUrl: TikTok video URLs are junk", () => {
  assert.equal(
    isJunkUrl("https://www.tiktok.com/@indonesia.archery/video/7553168224116952340"),
    true,
  );
});

test("isJunkUrl: YouTube watch and youtu.be short links are junk", () => {
  assert.equal(isJunkUrl("https://www.youtube.com/watch?v=aLONk-YhyI0"), true);
  assert.equal(isJunkUrl("https://youtu.be/abc123"), true);
});

test("isJunkUrl: Facebook posts are junk", () => {
  assert.equal(
    isJunkUrl("https://www.facebook.com/ArcheryNZ/posts/1123635939554117/"),
    true,
  );
  assert.equal(
    isJunkUrl("https://www.facebook.com/groups/495039997176761/posts/26768003509453718/"),
    true,
  );
});

test("isJunkUrl: Tweets are junk", () => {
  assert.equal(isJunkUrl("https://twitter.com/someuser/status/12345"), true);
  assert.equal(isJunkUrl("https://x.com/someuser/status/12345"), true);
});

test("isJunkUrl: WA Americas / Education / Awards homepages are junk", () => {
  assert.equal(isJunkUrl("https://www.worldarcheryamericas.com/en/home/"), true);
  assert.equal(isJunkUrl("https://education.worldarchery.org/"), true);
  assert.equal(isJunkUrl("https://www.worldarcheryawards.com/"), true);
});

test("isJunkUrl: regional PERPANI selection pages are junk", () => {
  assert.equal(isJunkUrl("https://perpanisawahlunto.org/seleksi-pplp/"), true);
  assert.equal(isJunkUrl("https://www.perpanikepri.id/seleksi-pplp/"), true);
});

test("isJunkUrl: third-party signup generators are junk", () => {
  assert.equal(
    isJunkUrl("https://www.signupgenius.com/go/10C0A4EADAA22A6FBC43-61869233-host"),
    true,
  );
  assert.equal(isJunkUrl("https://www.eventbrite.com/e/some-event"), true);
  assert.equal(isJunkUrl("https://www.jotform.com/abc"), true);
  assert.equal(isJunkUrl("https://forms.gle/xyz"), true);
});

test("isJunkUrl: asset CDNs and raw files are junk", () => {
  assert.equal(
    isJunkUrl("https://files.microcms-assets.io/assets/64fc/01_Archery.pdf"),
    true,
  );
  assert.equal(isJunkUrl("https://cdn.example.com/some.pdf"), true);
});

test("isJunkUrl: low-signal content sites and local clubs are junk", () => {
  assert.equal(isJunkUrl("https://www.kreedon.com/archery-world-cup-2024"), true);
  assert.equal(isJunkUrl("https://essarchery.com/en/academy/compound-bow-guide/"), true);
  assert.equal(isJunkUrl("https://www.castlearchers.com/cms/pdf.php?id=21"), true);
  assert.equal(isJunkUrl("https://nocindonesia.id/athlete?category=archery"), true);
  assert.equal(isJunkUrl("https://id.scribd.com/document/1032627289/technical-handbook"), true);
});

test("isJunkUrl: 'how to host' guides are junk (different topic from registration)", () => {
  assert.equal(
    isJunkUrl("https://www.usarchery.org/resource/guide-to-hosting-a-world-archery-sanctioned-tournament"),
    true,
  );
  // Sanity: usarchery.org without 'guide-to-hosting' is still legitimate
  assert.equal(
    isJunkUrl("https://www.usarchery.org/high-performance/international-team-selection-procedures"),
    false,
  );
});

test("isJunkUrl: legitimate article URLs are NOT junk", () => {
  // Real legitimate URLs that should pass through the filter.
  assert.equal(
    isJunkUrl("https://extranet.worldarchery.sport/documents/index.php/?doc=6527"),
    false,
  );
  assert.equal(
    isJunkUrl("https://www.worldarchery.sport/news/94182/fita-launches-it-new-online-registration-system"),
    false,
  );
  assert.equal(
    isJunkUrl("https://www.usarchery.org/resource/2026-world-archery-field-championships-selection-procedures"),
    false,
  );
  assert.equal(isJunkUrl("https://archery.org.au/2024-world-archery-events-selection-criteria/"), false);
  // PDF is fine if it's a real document.
  assert.equal(
    isJunkUrl("https://archery.org.au/wp-content/uploads/2026/03/World-Field-Archery-Championships-Selection-2026.pdf"),
    false,
  );
});

test("isJunkUrl: tolerates bad input safely", () => {
  assert.equal(isJunkUrl(""), false);
  assert.equal(isJunkUrl("not a url"), false);
  // Type guards
  assert.equal(isJunkUrl(undefined as unknown as string), false);
  assert.equal(isJunkUrl(null as unknown as string), false);
});

test("isJunkUrl: Instagram MAIN page (not /p/ or /reel/) is NOT junk", () => {
  // www.instagram.com/ (the profile/account) is fine — only specific
  // post/reel subpaths are filtered.
  assert.equal(isJunkUrl("https://www.instagram.com/indonesia.archery/"), false);
});
