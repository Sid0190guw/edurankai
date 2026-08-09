// src/lib/video-embed.ts — THE ONE PLACE A PASTED VIDEO LINK BECOMES SOMETHING WE WILL RENDER.
//
// WHY THIS FILE EXISTS.
// Before it, four surfaces each did their own thing with an author-supplied URL, and three of them
// put that string straight into an iframe:
//   - portal/courses/[slug].astro rendered `<iframe src={lesson.video_url}>` for a 'simulation'
//     lesson, `<video src={...}>` for anything it did not recognise, and `<a href={...}>` for a
//     'link' lesson. Astro escapes an attribute for HTML; it does not care about the SCHEME. A
//     stored `javascript:` or `data:text/html;base64,...` survived all three intact.
//   - aquintutor/courses/[slug]/learn/[lessonSlug].astro built the iframe as a STRING and assigned
//     it with innerHTML, "sanitising" with an esc() that replaces < > & " — an HTML-context escape,
//     not a URL validator. `javascript:alert(1)` went through untouched.
// Both pages are opened by signed-in employees and paying learners, so that was script execution in
// an authenticated session, plus an arbitrary third-party origin framed with allowfullscreen.
//
// THE RULE THIS FILE ENFORCES: a user-supplied string is NEVER interpolated into an iframe src. We
// parse the URL, require https, match the host and path against an allowlist of KNOWN SHAPES,
// extract an id whose character set we constrain, and BUILD the embed URL ourselves from that id.
// Anything that does not match is REFUSED at the point of entry with a sentence saying why — not
// stored to fail silently in front of a learner later.
//
// BRAND NAMES. Provider ids below are an INTERNAL enum. They must never reach a page a learner,
// applicant or employee reads: the user-facing string is `description`, which says what KIND of
// link it is ("a public video platform link"), never whose. Anything printed on screen comes from
// `describeVideoLink()` or the `description` field, and both are brand-free by construction.
//
// NO UPLOADS. Every branch here takes a URL. Nothing in this module stores, proxies or accepts a
// file. That is deliberate and permanent.
//
// Pure functions, no database, no Astro — so the unit tests run with `npx tsx`.

/** INTERNAL ONLY. Never render this value. See the brand-names note above. */
export type VideoProviderId =
  | 'platform_a'   // the large public video platform
  | 'platform_b'   // a video hosting service
  | 'platform_c'   // a second public video platform
  | 'recording_a'  // a screen-recording service
  | 'hosting_a'    // a business video host
  | 'drive_a'      // a shared-drive file
  | 'direct_file'  // a plain media file served over https
  | 'internal';    // a page on this platform

/**
 * How the resolved link is meant to be presented.
 *  - 'embed'    third-party player in a sandboxed iframe built by us
 *  - 'internal' a same-origin path (our own labs/rooms) in an iframe
 *  - 'file'     a direct media file in a <video> element (no script context at all)
 *  - 'link'     opens elsewhere, in a new tab, behind an honest button
 */
export type VideoLinkKind = 'embed' | 'internal' | 'file' | 'link';

export interface ResolvedVideoLink {
  ok: true;
  kind: VideoLinkKind;
  /** INTERNAL enum. Do not print. */
  provider: VideoProviderId;
  /** Exactly what the author pasted (trimmed). Stored so a provider change never costs a re-entry. */
  originalUrl: string;
  /** Built by us from the extracted id. This is the only string that may reach an iframe src. */
  embedUrl: string;
  /** The id we extracted, when the shape had one. Constrained character set. */
  videoId: string | null;
  /** User-facing, brand-free. Safe to print anywhere. */
  description: string;
  /** Attributes the renderer must apply. Kept here so every surface gets the same hardening. */
  sandbox: string;
  allow: string;
  referrerPolicy: string;
}

export interface RefusedVideoLink {
  ok: false;
  originalUrl: string;
  /** A complete sentence for a human. Shown in the admin form and never swallowed. */
  reason: string;
  /**
   * True when the link is safe to OPEN in a new tab even though we will not frame it — https, a
   * real public host, no embedded credentials. The admin form offers "opens elsewhere" only then.
   */
  canLinkOut: boolean;
  /** The normalised https URL to use for that link-out. Null when canLinkOut is false. */
  linkOutUrl: string | null;
}

export type VideoLinkResult = ResolvedVideoLink | RefusedVideoLink;

// ---------------------------------------------------------------------------------------------
// The hardening every framed embed carries.
//
// sandbox: allow-scripts + allow-same-origin are what a player needs to run on ITS OWN origin.
// Together they are only dangerous when the framed document is same-origin with US, which is why
// the 'internal' kind below uses a different set. Deliberately ABSENT:
//   allow-top-navigation*  — a framed page cannot navigate the learner away from the course.
//   allow-popups           — no ad or interstitial windows out of a lesson.
//   allow-modals / allow-forms — a player needs neither; a phishing form inside a lesson is the
//                            exact clickjacking shape this is here to stop.
const EMBED_SANDBOX = 'allow-scripts allow-same-origin allow-presentation';
// Same-origin content is our own code; sandboxing it against ourselves would only break it. It
// still may not navigate the top frame or open windows.
const INTERNAL_SANDBOX = 'allow-scripts allow-same-origin allow-presentation allow-forms allow-modals';
// Only what playback needs. No camera, no microphone, no geolocation, no payment.
const EMBED_ALLOW = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
// Send the origin, never the full course URL with its lesson id, to a third party.
const EMBED_REFERRER = 'strict-origin-when-cross-origin';

const DESC = {
  public_video: 'a public video platform link',
  video_host: 'a video hosting service link',
  recording: 'a screen recording link',
  drive: 'a shared drive file link',
  file: 'a direct video file link',
  internal: 'a page on this platform',
  link_out: 'a link that opens elsewhere',
} as const;

// ---------------------------------------------------------------------------------------------
// Allowlist. Each entry: which hosts it owns, how to pull an id out of a path, and how WE build the
// embed. `hosts` are compared against the hostname with a leading `www.` / `m.` removed.
interface ProviderSpec {
  provider: VideoProviderId;
  description: string;
  hosts: string[];
  /** Return the embed URL, or null when this host was matched but the path was not a video. */
  build: (u: URL) => { id: string; embedUrl: string } | null;
}

const ID_11 = /^[A-Za-z0-9_-]{11}$/;              // 11-char public-platform id
const DIGITS = /^[0-9]{6,12}$/;                   // numeric video id
const HEX32 = /^[a-f0-9]{32}$/i;                  // recording share id
const ALNUM = /^[A-Za-z0-9]{5,12}$/;              // short alphanumeric id
const DRIVE_ID = /^[A-Za-z0-9_-]{20,64}$/;        // drive file id
const HASH10 = /^[A-Za-z0-9]{6,20}$/;             // unlisted-video hash

/** Path split into non-empty segments. */
function segs(u: URL): string[] {
  return u.pathname.split('/').filter(Boolean);
}

const PROVIDERS: ProviderSpec[] = [
  {
    provider: 'platform_a',
    description: DESC.public_video,
    hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
    build: (u) => {
      const s = segs(u);
      let id: string | null = null;
      if (u.hostname.replace(/^(www|m)\./, '') === 'youtu.be') id = s[0] || null;
      else if (s[0] === 'watch') id = u.searchParams.get('v');
      else if (s[0] === 'embed' || s[0] === 'v' || s[0] === 'shorts' || s[0] === 'live') id = s[1] || null;
      if (!id || !ID_11.test(id)) return null;
      // The no-cookie host is this platform's own privacy variant: same player, no tracking cookie
      // until the learner presses play. rel=0 keeps "up next" inside the same channel.
      return { id, embedUrl: 'https://www.youtube-nocookie.com/embed/' + id + '?rel=0&modestbranding=1&playsinline=1' };
    },
  },
  {
    provider: 'platform_b',
    description: DESC.video_host,
    hosts: ['vimeo.com', 'player.vimeo.com'],
    build: (u) => {
      const s = segs(u);
      // /123456789, /video/123456789, /channels/x/123456789, /123456789/abcdef (unlisted hash)
      let id: string | null = null;
      let hash: string | null = null;
      for (let i = 0; i < s.length; i++) {
        if (DIGITS.test(s[i])) {
          id = s[i];
          if (s[i + 1] && HASH10.test(s[i + 1]) && !DIGITS.test(s[i + 1])) hash = s[i + 1];
          break;
        }
      }
      if (!id) return null;
      const h = hash || u.searchParams.get('h');
      const suffix = h && HASH10.test(h) ? '?h=' + h : '';
      return { id, embedUrl: 'https://player.vimeo.com/video/' + id + suffix };
    },
  },
  {
    provider: 'platform_c',
    description: DESC.public_video,
    hosts: ['dailymotion.com', 'dai.ly'],
    build: (u) => {
      const s = segs(u);
      const raw = u.hostname.replace(/^(www|m)\./, '') === 'dai.ly' ? s[0] : (s[0] === 'video' || s[0] === 'embed' ? s[s.length - 1] : null);
      // ids can carry a trailing slug after an underscore
      const id = raw ? raw.split('_')[0] : null;
      if (!id || !ALNUM.test(id)) return null;
      return { id, embedUrl: 'https://www.dailymotion.com/embed/video/' + id };
    },
  },
  {
    provider: 'recording_a',
    description: DESC.recording,
    hosts: ['loom.com'],
    build: (u) => {
      const s = segs(u);
      const id = (s[0] === 'share' || s[0] === 'embed') ? (s[1] || '') : '';
      if (!HEX32.test(id)) return null;
      return { id, embedUrl: 'https://www.loom.com/embed/' + id };
    },
  },
  {
    provider: 'hosting_a',
    description: DESC.video_host,
    hosts: ['wistia.com', 'wistia.net', 'fast.wistia.net', 'fast.wistia.com'],
    build: (u) => {
      const s = segs(u);
      const i = s.indexOf('medias') >= 0 ? s.indexOf('medias') : s.indexOf('iframe');
      const id = i >= 0 ? (s[i + 1] || '') : '';
      if (!/^[A-Za-z0-9]{8,16}$/.test(id)) return null;
      return { id, embedUrl: 'https://fast.wistia.net/embed/iframe/' + id };
    },
  },
  {
    provider: 'drive_a',
    description: DESC.drive,
    hosts: ['drive.google.com', 'docs.google.com'],
    build: (u) => {
      const s = segs(u);
      // /file/d/<id>/view  or  ?id=<id>
      let id: string | null = null;
      const d = s.indexOf('d');
      if (s[0] === 'file' && d >= 0) id = s[d + 1] || null;
      if (!id) id = u.searchParams.get('id');
      if (!id || !DRIVE_ID.test(id)) return null;
      return { id, embedUrl: 'https://drive.google.com/file/d/' + id + '/preview' };
    },
  },
];

// Hosts that are never a lesson video and are almost always pasted by mistake — a meeting invite
// dropped into a video field. Refused with a sentence that tells the author what to do instead.
const MEETING_HOSTS = ['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'teams.live.com', 'webex.com', 'meet.jit.si', 'whereby.com'];

const MEDIA_EXT = /\.(mp4|m4v|webm|ogv|ogg|mov)$/i;

/** A hostname we will not frame or link: loopback, bare host, private/reserved name, IP literal. */
function isNonPublicHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;           // IPv4 literal
  if (h.startsWith('[') || h.includes(':')) return true;        // IPv6 literal
  if (!h.includes('.')) return true;                            // bare host, e.g. "intranet"
  return false;
}

/** Our own origins, so an absolute link back to us is treated as an internal path. */
const OWN_HOSTS = ['edurankai.in', 'www.edurankai.in'];

/**
 * Resolve a pasted link into something we are willing to render, or refuse it with a reason.
 *
 * `allowLinkOut: true` means the author has explicitly chosen "this opens elsewhere" — we still
 * require https and a real public host, we simply do not frame it.
 */
export function resolveVideoLink(raw: unknown, opts?: { allowLinkOut?: boolean }): VideoLinkResult {
  const original = (raw == null ? '' : String(raw)).trim();
  const refuse = (reason: string, canLinkOut = false, linkOutUrl: string | null = null): RefusedVideoLink =>
    ({ ok: false, originalUrl: original, reason, canLinkOut, linkOutUrl });

  if (!original) return refuse('No link was given, so there is nothing to play.');
  if (original.length > 2000) return refuse('That link is too long to be a video address. Paste the address from the video\'s own page.');
  if (/[\s<>"'`]/.test(original)) return refuse('That link contains spaces or punctuation that cannot appear in a web address. Copy it again from the address bar.');

  // A same-origin path — our own labs, rooms and simulators. Single leading slash only: "//host"
  // is a protocol-relative URL to somewhere else entirely.
  if (original.startsWith('/') && !original.startsWith('//')) {
    if (!/^\/[A-Za-z0-9\-._~/]*(\?[A-Za-z0-9\-._~/=&%]*)?$/.test(original)) {
      return refuse('That looks like a page on this platform, but it contains characters we do not allow in an address.');
    }
    return {
      ok: true, kind: 'internal', provider: 'internal', originalUrl: original, embedUrl: original,
      videoId: null, description: DESC.internal,
      sandbox: INTERNAL_SANDBOX, allow: EMBED_ALLOW, referrerPolicy: 'same-origin',
    };
  }

  // Accept a pasted address with the scheme missing, but never invent a scheme for something that
  // already declared one (javascript:, data:, file: must be REFUSED, not rewritten).
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.\-]*:/.test(original);
  let u: URL;
  try {
    u = new URL(hasScheme ? original : 'https://' + original);
  } catch {
    return refuse('That is not a web address we can read. Copy the address from the browser bar of the page the video plays on.');
  }

  if (u.protocol !== 'https:') {
    if (u.protocol === 'http:') {
      return refuse('Only secure https links are accepted, and this one is plain http. Try the same address with https.');
    }
    return refuse('Only https web addresses are accepted. A "' + u.protocol.replace(':', '') + '" link cannot be played and will not be stored.');
  }
  if (u.username || u.password) {
    return refuse('That address carries a username or password in it. Remove those before saving.');
  }
  if (isNonPublicHost(u.hostname)) {
    return refuse('That address points at a private or local machine, which no learner would be able to reach.');
  }

  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');

  // Our own site written out in full — same as the path form above.
  if (OWN_HOSTS.includes(u.hostname.toLowerCase())) {
    const path = u.pathname + (u.search || '');
    return {
      ok: true, kind: 'internal', provider: 'internal', originalUrl: original, embedUrl: path,
      videoId: null, description: DESC.internal,
      sandbox: INTERNAL_SANDBOX, allow: EMBED_ALLOW, referrerPolicy: 'same-origin',
    };
  }

  const linkOut = u.toString();

  if (MEETING_HOSTS.some((m) => host === m || host.endsWith('.' + m))) {
    return refuse('That is a meeting link, not a recorded video. Add it as a live session instead, so people join at the right time.', false, null);
  }

  for (const p of PROVIDERS) {
    if (!p.hosts.some((h) => host === h || host.endsWith('.' + h))) continue;
    const built = p.build(u);
    if (!built) {
      return refuse(
        'We recognised where this link is hosted but not which video it points at. Open the video on its own page and copy the address from there (a channel, playlist or search address will not play).',
        true, linkOut,
      );
    }
    return {
      ok: true, kind: 'embed', provider: p.provider, originalUrl: original, embedUrl: built.embedUrl,
      videoId: built.id, description: p.description,
      sandbox: EMBED_SANDBOX, allow: EMBED_ALLOW, referrerPolicy: EMBED_REFERRER,
    };
  }

  // A plain media file. It goes into a <video> element, which has no script context at all, so an
  // arbitrary https host is a media fetch and nothing more.
  if (MEDIA_EXT.test(u.pathname)) {
    return {
      ok: true, kind: 'file', provider: 'direct_file', originalUrl: original, embedUrl: linkOut,
      videoId: null, description: DESC.file,
      sandbox: EMBED_SANDBOX, allow: EMBED_ALLOW, referrerPolicy: EMBED_REFERRER,
    };
  }

  if (opts?.allowLinkOut) {
    return {
      ok: true, kind: 'link', provider: 'direct_file', originalUrl: original, embedUrl: linkOut,
      videoId: null, description: DESC.link_out,
      sandbox: '', allow: '', referrerPolicy: EMBED_REFERRER,
    };
  }

  return refuse(
    'We could not recognise this as a video we are able to play inside the page. Paste the address shown when the video itself is open, or save it as a link that opens elsewhere.',
    true, linkOut,
  );
}

/**
 * One sentence for a human, in the admin form and in the learner-side fallback. Brand-free: it
 * names the KIND of link, never the company.
 */
export function describeVideoLink(r: VideoLinkResult): string {
  if (!r.ok) return r.reason;
  if (r.kind === 'embed') return 'Recognised as ' + r.description + '. It will play inside the lesson.';
  if (r.kind === 'file') return 'Recognised as ' + r.description + '. It will play inside the lesson.';
  if (r.kind === 'internal') return 'Recognised as ' + r.description + '. It will open inside the lesson.';
  return 'Saved as ' + r.description + '. Learners get a button that opens it in a new tab.';
}

/**
 * Render-time resolution for a stored lesson.
 *
 * The pasted address is the source of truth and is resolved fresh on every render, so a change to
 * how we build an embed reaches every existing lesson without anyone re-entering a link. The stored
 * derived form is the fallback for a row saved under an older allowlist — and it is re-validated
 * through the same function rather than trusted, because a column is only as trustworthy as the
 * last thing that wrote to it.
 */
export function resolveStoredVideo(
  storedOriginal: unknown,
  storedEmbed?: unknown,
  storedKind?: unknown,
): VideoLinkResult {
  const wantLinkOut = String(storedKind || '') === 'link';
  const first = resolveVideoLink(storedOriginal, { allowLinkOut: wantLinkOut });
  if (first.ok) return first;
  const derived = (storedEmbed == null ? '' : String(storedEmbed)).trim();
  if (derived && derived !== String(storedOriginal || '').trim()) {
    const second = resolveVideoLink(derived, { allowLinkOut: wantLinkOut });
    if (second.ok) return second;
  }
  return first;
}

/**
 * The columns a writer persists. Both forms are stored on purpose: the original so nobody is ever
 * asked to re-enter their links, the derived so a page can render without re-deriving and so a
 * later provider change is a migration we run, not a task we hand to authors.
 */
/**
 * THE SHARED URL SANITISER for everything that is not a player: an image src, a downloadable
 * attachment href, a plain outbound link.
 *
 * Returns a normalised absolute https URL, or a same-origin path, or NULL. Null means "do not put
 * this anywhere" — the caller must then say something in words rather than emit an empty element.
 * There is no allowlist of hosts here because an <img> and an <a download> are not script contexts;
 * what matters is the scheme, the credentials and that the host is real. `javascript:`, `data:`,
 * `blob:`, `file:`, plain http, `user:pass@`, loopback and IP literals are all refused.
 *
 * Before this existed, the block renderer escaped these values for HTML with a function that
 * replaces < > & " — an HTML-context escape that does nothing whatsoever to a scheme — and then put
 * the result into src and href attributes.
 */
export function safeResourceUrl(raw: unknown): string | null {
  const v = (raw == null ? '' : String(raw)).trim();
  if (!v || v.length > 2000) return null;
  if (/[\s<>"'`]/.test(v)) return null;
  if (v.startsWith('/') && !v.startsWith('//')) {
    return /^\/[A-Za-z0-9\-._~/]*(\?[A-Za-z0-9\-._~/=&%]*)?$/.test(v) ? v : null;
  }
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.\-]*:/.test(v);
  let u: URL;
  try { u = new URL(hasScheme ? v : 'https://' + v); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (isNonPublicHost(u.hostname)) return null;
  return u.toString();
}

export function videoColumnValues(r: VideoLinkResult): {
  video_url: string | null;
  video_embed_url: string | null;
  video_provider: string | null;
  video_link_kind: string | null;
} {
  if (!r.ok) return { video_url: null, video_embed_url: null, video_provider: null, video_link_kind: null };
  return {
    video_url: r.originalUrl,
    video_embed_url: r.embedUrl,
    video_provider: r.provider,
    video_link_kind: r.kind,
  };
}
