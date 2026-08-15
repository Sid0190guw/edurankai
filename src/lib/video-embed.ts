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
  | 'platform_d'   // a live-streaming platform's recorded videos
  | 'platform_e'   // a public archive of freely licensed media
  | 'platform_f'   // a federated, self-hostable open-source platform
  | 'platform_g'   // a large regional platform outside the US and EU
  | 'recording_a'  // a screen-recording service
  | 'hosting_a'    // a business video host
  | 'hosting_b'    // a developer video delivery service
  | 'hosting_c'    // a second developer video delivery service
  | 'hosting_d'    // an enterprise video platform
  | 'lecture_a'    // an institutional lecture-capture system
  | 'drive_a'      // a shared-drive file
  | 'drive_b'      // a second cloud drive
  | 'drive_c'      // a file-sync service
  | 'drive_d'      // a business file-sharing service
  | 'drive_e'      // an end-to-end encrypted file service
  | 'conference_a' // a conferencing service's cloud recording
  | 'direct_file'  // a plain media file served over https
  | 'internal';    // a page on this platform

/**
 * What the media at the other end actually IS, when `kind` is 'file'.
 *
 * ADDED AS A FIELD RATHER THAN AS NEW `kind` VALUES, on purpose. Four surfaces switch on `kind`,
 * and a fifth value would have fallen through every one of those switches into a default branch —
 * which is how a page silently renders nothing. Every existing reader keeps seeing 'file' and keeps
 * emitting a media element that works; readers that care can ask which sort of media it is.
 */
export type MediaKind = 'video' | 'audio' | 'hls' | 'dash';

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
  /**
   * Only set when kind is 'file'. 'video' plays in a <video>; 'audio' should go in an <audio>;
   * 'hls' and 'dash' are adaptive manifests, which a <video> plays natively on some browsers and
   * NOT on others — see needsStreamPlayer.
   */
  mediaKind?: MediaKind;
  /**
   * True for an adaptive manifest (hls/dash). No player library is installed in this project, so a
   * browser without native support for the format will show an empty player. A surface rendering
   * one of these MUST also offer the open-in-new-tab fallback rather than leave a black rectangle.
   */
  needsStreamPlayer?: boolean;
  /**
   * A precondition the AUTHOR has to satisfy for this link to work for anybody else — almost always
   * a sharing setting. Empty when there is nothing to warn about. Shown in the admin form; never a
   * reason to refuse, because we cannot check somebody's sharing settings from here.
   */
  warning?: string;
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
  audio_file: 'a direct audio file link',
  stream: 'a streaming video address',
  archive: 'a public media archive link',
  lecture: 'an institutional lecture recording link',
  conference: 'a meeting recording link',
  internal: 'a page on this platform',
  link_out: 'a link that opens elsewhere',
} as const;

/**
 * Sharing preconditions we cannot verify and therefore state instead.
 *
 * A drive link that plays perfectly for the author and for nobody else is the single most common
 * way a lesson video "does not work", and it is invisible from here: we cannot open somebody's file
 * to see whether it is public. So the resolver returns the sentence and the form prints it.
 */
const WARN = {
  drive_public: 'This will only play for learners if the file is shared so that anyone with the link can view it. Check that before you publish.',
  onedrive_embed: 'Use the address from the file\'s own Embed option, not the address bar — the ordinary sharing address cannot be played inside a page.',
  box_public: 'The shared link has to be set to public access, or learners will see a sign-in screen instead of the video.',
  encrypted_key: 'This address carries the decryption key in it. Anyone who gets the lesson link can watch the file, so do not use it for anything private.',
  stream_native: 'This is a streaming address. It plays natively in some browsers and not in others, and no player library is installed here, so learners on an unsupported browser get the open-in-a-new-tab fallback instead.',
  live_platform: 'A live-streaming platform address plays only while the recording is still available on that platform, and its player requires our own domain to be registered for embedding.',
} as const;

// ---------------------------------------------------------------------------------------------
// Allowlist. Each entry: which hosts it owns, how to pull an id out of a path, and how WE build the
// embed. `hosts` are compared against the hostname with a leading `www.` / `m.` removed.
interface ProviderSpec {
  provider: VideoProviderId;
  description: string;
  hosts: string[];
  /**
   * Match on the PATH SHAPE rather than on a fixed host list. Used by the one federated platform
   * here, which is self-hosted on thousands of different domains and so has no host list that could
   * ever be complete. When present, `hosts` may be empty and this decides.
   */
  hostShape?: (u: URL) => boolean;
  /**
   * False when the service is real and the link is valid but the page REFUSES TO BE FRAMED — it
   * sends X-Frame-Options or a frame-ancestors policy that a browser obeys before any of our code
   * runs. Framing it anyway produces a blank rectangle inside the lesson, which is worse than an
   * honest button, so these resolve to kind 'link'.
   */
  frameable?: boolean;
  /**
   * What to say when the host matched but the path did not. The generic sentence ("copy the address
   * from the video's own page") is useless for a service where the ordinary address is never the
   * playable one — there the author needs the specific instruction, not a shrug.
   */
  notFoundReason?: string;
  /**
   * Return the embed URL, or null when this host was matched but the path was not a video.
   * A `mediaKind` means the address serves the FILE ITSELF, so the result is a media element rather
   * than an iframe — the difference between a working player and a page nested inside a lesson.
   */
  build: (u: URL) => { id: string; embedUrl: string; warning?: string; description?: string; mediaKind?: MediaKind } | null;
}

const ID_11 = /^[A-Za-z0-9_-]{11}$/;              // 11-char public-platform id
const DIGITS = /^[0-9]{6,12}$/;                   // numeric video id
const HEX32 = /^[a-f0-9]{32}$/i;                  // recording share id
const ALNUM = /^[A-Za-z0-9]{5,12}$/;              // short alphanumeric id
const DRIVE_ID = /^[A-Za-z0-9_-]{20,64}$/;        // drive file id
const HASH10 = /^[A-Za-z0-9]{6,20}$/;             // unlisted-video hash
// The privacy hash as that service actually issues it: hex, and short. The {6,20} alphanumeric
// pattern above rejected a five-character hash and any hash that happened to be all digits, and a
// dropped hash turns an unlisted video into a player that says "private".
const VIMEO_HASH = /^[A-Za-z0-9]{4,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;  // lecture/federated id
// DELIBERATELY LONG. The federated entry is the only one matched on path shape rather than on a host
// list, so its id pattern is the whole thing standing between us and framing an arbitrary site that
// happens to have a /w/ route. Eight characters was not distinctive enough to be that.
const SHORT_UUID = /^[A-Za-z0-9]{16,24}$/;        // federated platform short id
const HEX_UID = /^[a-f0-9]{20,40}$/i;             // delivery-service video uid
const GUID_LOOSE = /^[A-Za-z0-9-]{20,64}$/;       // library guid
const SHARE_TOKEN = /^[A-Za-z0-9_-]{8,64}$/;      // an opaque share token
const PLAYLIST_ID = /^[A-Za-z0-9_-]{12,42}$/;     // public-platform playlist id
const BV_ID = /^BV[A-Za-z0-9]{8,12}$/;            // regional platform video id

/**
 * Our own domain, written into the one player address that demands to know who is framing it.
 *
 * Hardcoded to the production host on purpose: it is a value we send to a third party and it has to
 * match the deployment, and reading it from a request would let a caller on any host mint an address
 * claiming to be us. Declared HERE, above the table that reads it — `const` is not hoisted, and
 * although a closure would have survived it, this project has taken pages down over exactly that.
 */
// BOTH FORMS OF THE HOST, because that player matches the parent against the page's actual hostname
// and this site answers on the bare domain and on www. Naming only one would have worked on exactly
// half the addresses learners reach the course through, which is the sort of bug that looks random.
const EMBED_PARENTS = '&parent=edurankai.in&parent=www.edurankai.in';

/** Seconds offset from `t`/`start`, when the author copied the link at a timestamp. */
function startSeconds(u: URL): number | null {
  const raw = u.searchParams.get('t') || u.searchParams.get('start') || '';
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Math.min(86400, Number(raw));
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Math.min(86400, Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0));
}

/** Path split into non-empty segments. Dot-only segments are dropped, so a traversal written into a
 *  path (`/details/../../x`) can never become part of an id we then build an address out of. */
function segs(u: URL): string[] {
  return u.pathname.split('/').filter((s) => s && !/^\.+$/.test(s));
}

// Declared HERE, above the provider table whose builders call mediaKindFor(). `const` is not
// hoisted; the function is, and reaching a later const through a hoisted function is exactly the
// trap this project has taken pages down over. Order removes the question.
const MEDIA_EXT = /\.(mp4|m4v|webm|ogv|ogg|mov)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|opus|oga|weba)$/i;
const HLS_EXT = /\.m3u8$/i;
const DASH_EXT = /\.mpd$/i;

/** Which sort of media a path names, or null when it names none. Pure. */
function mediaKindFor(pathname: string): MediaKind | null {
  if (HLS_EXT.test(pathname)) return 'hls';
  if (DASH_EXT.test(pathname)) return 'dash';
  if (AUDIO_EXT.test(pathname)) return 'audio';
  if (MEDIA_EXT.test(pathname)) return 'video';
  return null;
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

      // A PLAYLIST IS A LEGITIMATE TEACHING UNIT and used to be refused outright with "a channel,
      // playlist or search address will not play". A course reading list is very often exactly a
      // playlist, so the videoseries form is built for it. A watch URL that ALSO carries a list is
      // still treated as the single video the author was looking at, not as the whole list.
      if (!id) {
        const list = u.searchParams.get('list');
        if ((s[0] === 'playlist' || s[0] === 'embed') && list && PLAYLIST_ID.test(list)) {
          return { id: list, embedUrl: 'https://www.youtube-nocookie.com/embed/videoseries?list=' + list + '&rel=0&modestbranding=1&playsinline=1' };
        }
      }
      if (!id || !ID_11.test(id)) return null;

      // The no-cookie host is this platform's own privacy variant: same player, no tracking cookie
      // until the learner presses play. rel=0 keeps "up next" inside the same channel.
      // A timestamp in the pasted link is KEPT — an author linking to 14:32 of a lecture meant it,
      // and dropping it silently sends every learner back to the start of an hour.
      const at = startSeconds(u);
      const start = at ? '&start=' + at : '';
      return { id, embedUrl: 'https://www.youtube-nocookie.com/embed/' + id + '?rel=0&modestbranding=1&playsinline=1' + start };
    },
  },
  {
    provider: 'platform_b',
    description: DESC.video_host,
    hosts: ['vimeo.com', 'player.vimeo.com'],
    build: (u) => {
      const s = segs(u);

      // A LIVE EVENT AND A SHOWCASE ARE NOT VIDEOS, AND THEY CARRY A NUMBER TOO.
      //
      // The id below is found by scanning every path segment for digits, which is what makes the
      // half-dozen ordinary shapes work. It also meant /event/<id> and /showcase/<id> — a scheduled
      // livestream and a curated set, both with numeric ids — matched, and were rendered as an
      // ordinary single-video player pointed at an id that is not a video's. That is the worst
      // class of wrong answer here: not a refusal an author can act on, but a lesson that saves
      // cleanly and plays nothing. Both have their own real embed address, so they get it.
      if (s[0] === 'event' && DIGITS.test(s[1] || '')) {
        return { id: s[1], embedUrl: 'https://vimeo.com/event/' + s[1] + '/embed' };
      }
      if (s[0] === 'showcase' && DIGITS.test(s[1] || '')) {
        return { id: s[1], embedUrl: 'https://vimeo.com/showcase/' + s[1] + '/embed' };
      }

      // /123456789, /video/123456789, /channels/x/123456789, /123456789/abcdef (unlisted hash)
      let id: string | null = null;
      let hash: string | null = null;
      for (let i = 0; i < s.length; i++) {
        if (DIGITS.test(s[i])) {
          id = s[i];
          if (s[i + 1] && VIMEO_HASH.test(s[i + 1]) && !DIGITS.test(s[i + 1])) hash = s[i + 1];
          break;
        }
      }
      if (!id) return null;
      const h = hash || u.searchParams.get('h');
      // The privacy hash is what makes an unlisted video playable at all. Dropping one because it
      // was five characters, or because it happened to be all digits, published a lesson whose
      // video answers "private" — so the accepted shape is now the shape they actually issue.
      const suffix = h && VIMEO_HASH.test(h) ? '?h=' + h : '';
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
      return { id, embedUrl: 'https://drive.google.com/file/d/' + id + '/preview', warning: WARN.drive_public };
    },
  },

  // ------------------------------------------------------------------------------------------
  // Everything below was added when the question "can we take a video from anywhere?" was asked
  // and the honest answer was "from six places". Each entry builds the embed address from an id we
  // extracted; none of them ever passes the pasted string through.
  // ------------------------------------------------------------------------------------------

  {
    // A public archive of freely licensed media. Enormously relevant to teaching — public-domain
    // lectures, historical footage, out-of-copyright film — and it publishes a clean embed path.
    provider: 'platform_e',
    description: DESC.archive,
    hosts: ['archive.org'],
    build: (u) => {
      const s = segs(u);
      if (s[0] !== 'details' && s[0] !== 'embed') return null;
      const id = s[1] || '';
      if (!/^[A-Za-z0-9._-]{2,120}$/.test(id)) return null;
      // A second segment is a file inside the item; the embed player accepts it as a path.
      const file = s[2] && /^[A-Za-z0-9._%-]{1,160}$/.test(s[2]) ? '/' + s[2] : '';
      return { id, embedUrl: 'https://archive.org/embed/' + id + file };
    },
  },

  {
    // A federated, self-hostable platform. THERE IS NO HOST LIST THAT COULD EVER BE COMPLETE — the
    // whole point of it is that anybody runs their own — so this is the one entry matched on PATH
    // SHAPE. The id charset is constrained exactly as tightly as everywhere else, the embed address
    // is still built by us, and the iframe sandbox is unchanged, so an unknown host here has no more
    // power than a known one.
    provider: 'platform_f',
    description: DESC.video_host,
    hosts: [],
    hostShape: (u) => {
      const s = segs(u);
      if (s[0] === 'w' && s.length === 2) return UUID.test(s[1]) || SHORT_UUID.test(s[1]);
      if (s[0] === 'videos' && (s[1] === 'watch' || s[1] === 'embed') && s[2]) return UUID.test(s[2]) || SHORT_UUID.test(s[2]);
      return false;
    },
    build: (u) => {
      const s = segs(u);
      const id = s[0] === 'w' ? s[1] : s[2];
      if (!id || (!UUID.test(id) && !SHORT_UUID.test(id))) return null;
      return { id, embedUrl: 'https://' + u.hostname + '/videos/embed/' + id };
    },
  },

  {
    // A live-streaming platform's saved videos and clips. The player REQUIRES the embedding domain
    // to be named in the address, which is why our own host is written into it rather than guessed.
    provider: 'platform_d',
    description: DESC.public_video,
    hosts: ['twitch.tv'],
    build: (u) => {
      const s = segs(u);
      if (s[0] === 'videos' && /^[0-9]{6,12}$/.test(s[1] || '')) {
        return { id: s[1], embedUrl: 'https://player.twitch.tv/?video=' + s[1] + EMBED_PARENTS + '&autoplay=false', warning: WARN.live_platform };
      }
      const clip = s[0] === 'clip' ? s[1] : (s[1] === 'clip' ? s[2] : null);
      if (clip && /^[A-Za-z0-9_-]{6,80}$/.test(clip)) {
        return { id: clip, embedUrl: 'https://clips.twitch.tv/embed?clip=' + clip + EMBED_PARENTS + '&autoplay=false', warning: WARN.live_platform };
      }
      return null;
    },
  },

  {
    // A large regional platform. Included because "consider every source" has to mean sources
    // outside the US and EU too, and a physics lecture is a physics lecture wherever it is hosted.
    provider: 'platform_g',
    description: DESC.public_video,
    hosts: ['bilibili.com', 'b23.tv'],
    build: (u) => {
      const s = segs(u);
      const id = s[0] === 'video' ? s[1] : (BV_ID.test(s[0] || '') ? s[0] : null);
      if (!id || !BV_ID.test(id)) return null;
      return { id, embedUrl: 'https://player.bilibili.com/player.html?bvid=' + id + '&autoplay=0' };
    },
  },

  {
    // A developer video delivery service. Two address families: the per-customer subdomain and the
    // shared delivery domain. Both carry the same uid, and both have a documented iframe path.
    provider: 'hosting_b',
    description: DESC.video_host,
    hosts: ['cloudflarestream.com', 'videodelivery.net'],
    build: (u) => {
      const s = segs(u);
      const uid = (s[0] && HEX_UID.test(s[0])) ? s[0] : null;
      if (!uid) return null;
      // The customer subdomain form keeps its own host; the shared form has a dedicated iframe host.
      const isCustomer = /cloudflarestream\.com$/i.test(u.hostname);
      return {
        id: uid,
        embedUrl: isCustomer
          ? 'https://' + u.hostname + '/' + uid + '/iframe'
          : 'https://iframe.videodelivery.net/' + uid,
      };
    },
  },

  {
    // A second developer delivery service, whose player address is library id plus video guid.
    provider: 'hosting_c',
    description: DESC.video_host,
    hosts: ['mediadelivery.net', 'iframe.mediadelivery.net'],
    build: (u) => {
      const s = segs(u);
      if ((s[0] !== 'embed' && s[0] !== 'play') || !s[1] || !s[2]) return null;
      if (!/^[0-9]{1,10}$/.test(s[1]) || !GUID_LOOSE.test(s[2])) return null;
      return { id: s[1] + '/' + s[2], embedUrl: 'https://iframe.mediadelivery.net/embed/' + s[1] + '/' + s[2] };
    },
  },

  {
    // An enterprise video platform. Only the fully-formed player address is accepted, because the
    // account and player ids cannot be derived from anything else the author might paste.
    provider: 'hosting_d',
    description: DESC.video_host,
    hosts: ['brightcove.net', 'players.brightcove.net'],
    build: (u) => {
      const s = segs(u);
      const videoId = u.searchParams.get('videoId') || '';
      if (!s[0] || !s[1] || !/^[0-9]{6,20}$/.test(s[0]) || !/^[0-9]{6,20}$/.test(videoId)) return null;
      const player = /^[A-Za-z0-9_-]{2,40}$/.test(s[1]) ? s[1] : 'default';
      return { id: videoId, embedUrl: 'https://players.brightcove.net/' + s[0] + '/' + player + '/index.html?videoId=' + videoId };
    },
  },

  {
    // An institutional lecture-capture system. Every university runs it on its own subdomain, so the
    // host match is by suffix and the viewer address converts to an embed address one-for-one. This
    // is the single most likely thing a partner university's faculty will paste.
    provider: 'lecture_a',
    description: DESC.lecture,
    hosts: ['panopto.com', 'panopto.eu', 'panopto.jp'],
    build: (u) => {
      if (!/\/Panopto\/Pages\/(Viewer|Embed)\.aspx$/i.test(u.pathname)) return null;
      const id = u.searchParams.get('id') || '';
      if (!UUID.test(id)) return null;
      return { id, embedUrl: 'https://' + u.hostname + '/Panopto/Pages/Embed.aspx?id=' + id + '&autoplay=false&showtitle=false' };
    },
  },

  {
    // A second cloud drive. Only the address produced by the file's own Embed option can be framed;
    // the ordinary share address renders a sign-in wall inside the lesson. So the embed form is
    // accepted and the share form is refused WITH the instruction, rather than accepted and broken.
    provider: 'drive_b',
    description: DESC.drive,
    hosts: ['onedrive.live.com', '1drv.ms', 'sharepoint.com'],
    notFoundReason: 'That address opens the file in its own site, which cannot be played inside a lesson. Open the file, choose its Embed option, and paste the address from the code it gives you.',
    build: (u) => {
      const host = u.hostname.toLowerCase();
      if (host.endsWith('sharepoint.com')) {
        if (!/embed\.aspx$/i.test(u.pathname)) return null;
        const uid = u.searchParams.get('UniqueId') || u.searchParams.get('uniqueId') || '';
        if (!uid) return null;
        return { id: uid, embedUrl: u.toString(), warning: WARN.onedrive_embed };
      }
      if (host === '1drv.ms') return null;   // a shortened address; nothing to extract without following it
      if (!/^\/embed$/i.test(u.pathname)) return null;
      const resid = u.searchParams.get('resid') || '';
      if (!resid) return null;
      return { id: resid, embedUrl: u.toString(), warning: WARN.onedrive_embed };
    },
  },

  {
    // A file-sync service. ITS SHARE ADDRESS ENDS IN .mp4 AND SERVES AN HTML PAGE, which is why this
    // entry has to exist and has to come BEFORE the direct-file branch: without it the address
    // matched the media-extension test, was accepted as a plain file, and produced a <video> element
    // pointed at a web page — a black rectangle in the lesson with nothing anywhere saying why.
    provider: 'drive_c',
    description: DESC.drive,
    hosts: ['dropbox.com', 'dropboxusercontent.com'],
    notFoundReason: 'That is a shared folder or a file we cannot tell is a video. Open the file itself and copy its address — the address has to end in the video file\'s own name.',
    build: (u) => {
      const path = u.pathname;
      if (!/^\/(s|scl)\//.test(path) && !/dropboxusercontent\.com$/i.test(u.hostname)) return null;
      // The raw form serves the FILE; the ordinary share address serves an HTML page that happens to
      // end in .mp4. Returning a mediaKind is what tells the resolver to hand this to a media
      // element rather than to an iframe.
      const media = mediaKindFor(path);
      if (!media) return null;
      const direct = new URL(u.toString());
      direct.searchParams.delete('dl');
      direct.searchParams.set('raw', '1');
      return { id: path, embedUrl: direct.toString(), warning: WARN.drive_public, mediaKind: media };
    },
  },

  {
    // A business file-sharing service with a documented embed path off the shared-link name.
    provider: 'drive_d',
    description: DESC.drive,
    hosts: ['box.com', 'app.box.com'],
    build: (u) => {
      const s = segs(u);
      const i = s.indexOf('s');
      if (i < 0 || !s[i + 1] || !SHARE_TOKEN.test(s[i + 1])) return null;
      return { id: s[i + 1], embedUrl: 'https://' + u.hostname + '/embed/s/' + s[i + 1], warning: WARN.box_public };
    },
  },

  {
    // An end-to-end encrypted file service. Its embed address carries the DECRYPTION KEY in the
    // fragment, so the warning is not about sharing settings — it is that the lesson link becomes
    // the key. Stated plainly rather than left for somebody to discover.
    provider: 'drive_e',
    description: DESC.drive,
    hosts: ['mega.nz', 'mega.io'],
    build: (u) => {
      const s = segs(u);
      if (s[0] !== 'embed' && s[0] !== 'file') return null;
      const id = s[1] || '';
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
      const key = (u.hash || '').replace(/^#/, '');
      if (!/^[A-Za-z0-9_,-]{16,128}$/.test(key)) return null;
      return { id, embedUrl: 'https://mega.nz/embed/' + id + '#' + key, warning: WARN.encrypted_key };
    },
  },

  {
    // A conferencing service's CLOUD RECORDING — not a meeting invitation. These pages refuse to be
    // framed, so this resolves to an honest button rather than to an empty rectangle. It sits above
    // the meeting-host refusal below, which used to catch recording addresses too and tell the
    // author to "add it as a live session" — advice that made no sense for a recording of one.
    provider: 'conference_a',
    description: DESC.conference,
    hosts: ['zoom.us'],
    frameable: false,
    // An address on this host that is NOT a recording is a meeting invitation, and this is the
    // sentence the blanket host refusal used to give. It is kept word-for-word so that moving the
    // provider loop above that refusal changed which addresses get it, and nothing else.
    notFoundReason: 'That is a meeting link, not a recorded video. Add it as a live session instead, so people join at the right time.',
    build: (u) => {
      const s = segs(u);
      if (s[0] !== 'rec') return null;
      return { id: s.slice(1).join('/'), embedUrl: u.toString() };
    },
  },
];

// Hosts that are never a lesson video and are almost always pasted by mistake — a meeting invite
// dropped into a video field. Refused with a sentence that tells the author what to do instead.
const MEETING_HOSTS = ['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'teams.live.com', 'webex.com', 'meet.jit.si', 'whereby.com'];

/** The generic "we know the host, not the video" sentence, so a provider can override just its own. */
const GENERIC_NOT_FOUND =
  'We recognised where this link is hosted but not which video it points at. Open the video on its own page and copy the address from there (a channel or search address will not play).';

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
    // A FRAGMENT IS PART OF A DEEP LINK, and this pattern had no room for one — so an address into a
    // particular part of one of our own labs or rooms was refused as containing "characters we do
    // not allow", which is true of the hash and misleading about everything else. The charset stays
    // exactly as tight; it simply now has an optional #fragment on the end.
    if (!/^\/[A-Za-z0-9\-._~/]*(\?[A-Za-z0-9\-._~/=&%]*)?(#[A-Za-z0-9\-._~/=&%]*)?$/.test(original)) {
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
    // The fragment travelled with the path form above and was dropped here, so the same deep link
    // behaved differently depending on whether the author pasted it with the domain or without.
    const path = u.pathname + (u.search || '') + (u.hash || '');
    return {
      ok: true, kind: 'internal', provider: 'internal', originalUrl: original, embedUrl: path,
      videoId: null, description: DESC.internal,
      sandbox: INTERNAL_SANDBOX, allow: EMBED_ALLOW, referrerPolicy: 'same-origin',
    };
  }

  const linkOut = u.toString();

  // THE PROVIDER LOOP RUNS BEFORE THE MEETING REFUSAL, and that order is the fix for a real wrong
  // answer: a conferencing service's CLOUD RECORDING lives on the same host as its meeting
  // invitations, so the blanket host refusal caught recordings too and told the author to "add it as
  // a live session instead" — advice that is nonsense for a recording of a session that has ended.
  // A provider that matches the path wins; only an address no provider claimed falls through to the
  // meeting refusal below.
  let matched: ProviderSpec | null = null;
  for (const p of PROVIDERS) {
    const hostMatch = p.hosts.some((h) => host === h || host.endsWith('.' + h));
    const shapeMatch = !hostMatch && !!p.hostShape && p.hostShape(u);
    if (!hostMatch && !shapeMatch) continue;
    const built = p.build(u);
    if (!built) { matched = p; break; }

    // The provider says this address serves the media itself. It goes to a media element, which has
    // no script context, rather than into an iframe.
    if (built.mediaKind) {
      const streamed = built.mediaKind === 'hls' || built.mediaKind === 'dash';
      return {
        ok: true, kind: 'file', provider: p.provider, originalUrl: original, embedUrl: built.embedUrl,
        videoId: built.id,
        description: built.description || (built.mediaKind === 'audio' ? DESC.audio_file : p.description),
        mediaKind: built.mediaKind,
        needsStreamPlayer: streamed,
        warning: built.warning || (streamed ? WARN.stream_native : undefined),
        sandbox: EMBED_SANDBOX, allow: EMBED_ALLOW, referrerPolicy: EMBED_REFERRER,
      };
    }

    // A page that refuses to be framed resolves to a button, not to a blank rectangle in a lesson.
    if (p.frameable === false) {
      return {
        ok: true, kind: 'link', provider: p.provider, originalUrl: original, embedUrl: built.embedUrl,
        videoId: built.id, description: built.description || p.description,
        sandbox: '', allow: '', referrerPolicy: EMBED_REFERRER,
        warning: built.warning,
      };
    }

    return {
      ok: true, kind: 'embed', provider: p.provider, originalUrl: original, embedUrl: built.embedUrl,
      videoId: built.id, description: built.description || p.description,
      sandbox: EMBED_SANDBOX, allow: EMBED_ALLOW, referrerPolicy: EMBED_REFERRER,
      warning: built.warning,
    };
  }

  if (!matched && MEETING_HOSTS.some((m) => host === m || host.endsWith('.' + m))) {
    return refuse('That is a meeting link, not a recorded video. Add it as a live session instead, so people join at the right time.', false, null);
  }

  if (matched) {
    // THE "OPENS ELSEWHERE" CHOICE HAD NO EFFECT ON A RECOGNISED HOST, which is the one place an
    // author is most likely to want it. A channel page, a course index, a live event that has not
    // started — all sit on hosts we know, all failed their provider's path check, and all came back
    // refused with `canLinkOut: true` and a checkbox that then changed nothing, because this branch
    // returned before anything read the option. A dead control is worse than an absent one: the
    // author ticks it, saves nothing, and has no idea why.
    if (opts?.allowLinkOut && matched.frameable !== false) {
      return {
        ok: true, kind: 'link', provider: matched.provider, originalUrl: original, embedUrl: linkOut,
        videoId: null, description: DESC.link_out,
        sandbox: '', allow: '', referrerPolicy: EMBED_REFERRER,
      };
    }
    return refuse(matched.notFoundReason || GENERIC_NOT_FOUND, true, linkOut);
  }

  // A plain media file. It goes into a media element, which has no script context at all, so an
  // arbitrary https host is a media fetch and nothing more.
  //
  // FOUR SHAPES, NOT ONE. A lesson is not always an mp4: audio-only material is a first-class
  // teaching resource and used to be refused outright, and an adaptive manifest is how anything
  // long is actually delivered. Each is reported as what it is so the player can render the right
  // element instead of putting an audio file in a <video> and showing a black box with sound.
  const media = mediaKindFor(u.pathname);
  if (media) {
    const isStream = media === 'hls' || media === 'dash';
    return {
      ok: true, kind: 'file', provider: 'direct_file', originalUrl: original, embedUrl: linkOut,
      videoId: null,
      description: media === 'audio' ? DESC.audio_file : (isStream ? DESC.stream : DESC.file),
      mediaKind: media,
      needsStreamPlayer: isStream,
      warning: isStream ? WARN.stream_native : undefined,
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
