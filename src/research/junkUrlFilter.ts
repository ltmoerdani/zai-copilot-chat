/**
 * URL filters for the research orchestrator.
 *
 * When the Z.AI Web Search returns a list of candidate URLs, many of
 * them are not actually articles. They're social-media reels, video
 * pages, plain site homepages, or login pages — none of which yield
 * useful content for a research report.
 *
 * Filtering them out at the candidate stage avoids:
 *   - 30-second webRead timeouts (Instagram, TikTok, YouTube often hang)
 *   - Burning the Z.AI MCP monthly quota on reads that return nothing
 *   - Junk sources getting into the final synthesis
 *
 * Free of `vscode` imports so it can be unit-tested under plain Node.
 */

interface JunkPattern {
  /** Hostname fragment (case-insensitive). Matched against the URL host. */
  hostFragment: string;
  /**
   * Optional URL path fragment. If set, both host AND path must match
   * before the URL is considered junk. Useful for keeping the host
   * in scope but only filtering specific sub-paths (e.g. /p/, /reel/).
   */
  pathFragment?: string;
  /** Human-readable reason for diagnostics. */
  reason: string;
}

/**
 * Junk URL patterns. Each entry says: "URLs whose host (and optionally
 * path) contain this fragment are junk because <reason>."
 *
 * Patterns are checked in order; first match wins.
 */
const JUNK_PATTERNS: JunkPattern[] = [
  // Social-media content (almost always timeouts + empty content).
  { hostFragment: "instagram.com", pathFragment: "/p/", reason: "Instagram post" },
  { hostFragment: "instagram.com", pathFragment: "/reel/", reason: "Instagram reel" },
  { hostFragment: "tiktok.com", pathFragment: "/video/", reason: "TikTok video" },
  { hostFragment: "youtube.com", pathFragment: "/watch", reason: "YouTube video page" },
  { hostFragment: "youtu.be", reason: "YouTube short link" },
  { hostFragment: "facebook.com", pathFragment: "/posts/", reason: "Facebook post" },
  { hostFragment: "facebook.com", pathFragment: "groups/", reason: "Facebook group post" },
  { hostFragment: "twitter.com", pathFragment: "/status/", reason: "Tweet" },
  { hostFragment: "x.com", pathFragment: "/status/", reason: "Tweet" },

  // Site homepages (no article content).
  { hostFragment: "worldarcheryamericas.com", reason: "WA Americas homepage" },
  { hostFragment: "education.worldarchery.org", reason: "WA Education homepage" },
  { hostFragment: "worldarcheryawards.com", reason: "WA Awards homepage (not registration)" },

  // Generic "PPLP selection" announcements (regional, low signal for the
  // international registration topic the user asked about). Keep the
  // domain so the URL pattern is clearly regional.
  { hostFragment: "perpanisawahlunto", reason: "Regional PERPANI selection page" },
  { hostFragment: "perpanikepri", reason: "Regional PERPANI selection page" },

  // Signup / event-management tools (third-party forms, not registration
  // procedures). E.g. signupgenius.com, eventbrite.com, jotform.com.
  { hostFragment: "signupgenius.com", reason: "Third-party signup form" },
  { hostFragment: "eventbrite.com", reason: "Third-party event page" },
  { hostFragment: "jotform.com", reason: "Third-party form builder" },
  { hostFragment: "forms.gle", reason: "Google Forms link" },

  // Generic asset CDNs (raw PDFs/images with no article context).
  { hostFragment: "files.microcms-assets.io", reason: "Asset CDN" },
  { hostFragment: "microcms-assets.io", reason: "Asset CDN" },
  { hostFragment: "cdn.", reason: "CDN host" },

  // Low-signal content sites (blogs, generic tutorials, local clubs).
  { hostFragment: "kreedon.com", reason: "Generic sports blog" },
  { hostFragment: "essarchery.com", reason: "Tutorial site, not registration" },
  { hostFragment: "castlearchers.com", reason: "Local archery club" },
  { hostFragment: "nocindonesia.id", pathFragment: "/athlete", reason: "Athlete directory, not registration" },
  { hostFragment: "scribd.com", reason: "Document host, often paywalled" },
  { hostFragment: "id.scribd.com", reason: "Document host, often paywalled" },

  // "How to host" / "guide to hosting" pages — about hosting, not registering.
  { hostFragment: "usarchery.org", pathFragment: "guide-to-hosting", reason: "How-to-host guide" },
  { hostFragment: "usarchery.org", pathFragment: "how-to-host", reason: "How-to-host guide" },
];

/**
 * Return true if the URL is a known-junk pattern (social media reel,
 * video page, site homepage, regional selection page). The orchestrator
 * uses this to drop the URL before the expensive webRead call.
 *
 * Returns false for unknown hosts or non-matching paths so we don't
 * accidentally filter legitimate articles.
 */
export function isJunkUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0) return false;

  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    // Bad URL — be conservative, don't filter (let downstream decide).
    return false;
  }

  for (const pattern of JUNK_PATTERNS) {
    if (!host.includes(pattern.hostFragment.toLowerCase())) continue;
    if (pattern.pathFragment && !path.includes(pattern.pathFragment.toLowerCase())) {
      continue;
    }
    return true;
  }
  return false;
}
