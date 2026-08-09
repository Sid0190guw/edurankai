// src/lib/video-embed.test.ts — run: npx tsx src/lib/video-embed.test.ts
// The point of these tests is the REFUSALS. A pasted link reaches an iframe on a page signed-in
// employees and paying learners open, so "does a good link work" is the easy half; "does a hostile
// string get turned away, and does the author read a sentence saying why" is the half that matters.
import { resolveVideoLink, resolveStoredVideo, describeVideoLink, videoColumnValues } from './video-embed';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (!c && extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

// --- refusals: schemes that are script execution -------------------------------------------
for (const bad of [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://evil.example/1234',
]) {
  const r = resolveVideoLink(bad);
  ok('refused: ' + bad.slice(0, 28), !r.ok, r);
  if (!r.ok) ok('  refusal is a sentence', r.reason.length > 25 && r.reason.trim().endsWith('.'), r.reason);
}

// A scheme-less paste must never be rewritten INTO a scheme that then passes.
const jsNoScheme = resolveVideoLink('javascript:void(document.cookie)');
ok('scheme-less rewrite does not launder javascript:', !jsNoScheme.ok);

// --- refusals: transport and host ------------------------------------------------------------
ok('http refused', !resolveVideoLink('http://youtu.be/dQw4w9WgXcQ').ok);
ok('credentials in URL refused', !resolveVideoLink('https://user:pw@vimeo.com/123456789').ok);
ok('localhost refused', !resolveVideoLink('https://localhost/video.mp4').ok);
ok('IPv4 literal refused', !resolveVideoLink('https://10.0.0.5/v.mp4').ok);
ok('bare intranet host refused', !resolveVideoLink('https://intranet/v.mp4').ok);
ok('protocol-relative not treated as internal', (() => { const r = resolveVideoLink('//evil.example/x'); return !r.ok || r.kind !== 'internal'; })());
ok('empty refused', !resolveVideoLink('').ok);
ok('whitespace-injected refused', !resolveVideoLink('https://youtu.be/dQw4w9WgXcQ" onload="alert(1)').ok);

// --- the known shapes ------------------------------------------------------------------------
const cases: [string, string][] = [
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&playsinline=1'],
  ['https://youtu.be/dQw4w9WgXcQ?t=42', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&playsinline=1'],
  ['https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxyz', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&playsinline=1'],
  ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&playsinline=1'],
  ['youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&playsinline=1'],
  ['https://vimeo.com/123456789', 'https://player.vimeo.com/video/123456789'],
  ['https://vimeo.com/123456789/abc123def4', 'https://player.vimeo.com/video/123456789?h=abc123def4'],
  ['https://www.dailymotion.com/video/x7tgad0', 'https://www.dailymotion.com/embed/video/x7tgad0'],
  ['https://www.loom.com/share/0123456789abcdef0123456789abcdef', 'https://www.loom.com/embed/0123456789abcdef0123456789abcdef'],
  ['https://drive.google.com/file/d/1A2B3C4D5E6F7G8H9I0J1K2L/view?usp=sharing', 'https://drive.google.com/file/d/1A2B3C4D5E6F7G8H9I0J1K2L/preview'],
];
for (const [input, expected] of cases) {
  const r = resolveVideoLink(input);
  ok('embed built for ' + input.slice(0, 46), r.ok && r.kind === 'embed' && r.embedUrl === expected, r);
}

// The embed URL is BUILT, never the pasted string — the whole safety argument in one assertion.
const tricky = resolveVideoLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&evil=%22%3E%3Cscript%3E');
ok('query junk never survives into the embed url', tricky.ok && !tricky.embedUrl.includes('evil') && !tricky.embedUrl.includes('script'), tricky);

// A recognised host with an unrecognised path is refused, and offers a link-out instead.
const channel = resolveVideoLink('https://www.youtube.com/@somechannel');
ok('channel address refused', !channel.ok);
ok('channel address offers link-out', !channel.ok && channel.canLinkOut && !!channel.linkOutUrl, channel);

// An 11-character id is the only thing accepted for the public platform.
ok('short id refused', !resolveVideoLink('https://youtu.be/abc').ok);

// --- direct file, internal path, link-out ----------------------------------------------------
const f = resolveVideoLink('https://cdn.example.org/lessons/intro.mp4');
ok('direct media file recognised', f.ok && f.kind === 'file', f);
const ip = resolveVideoLink('/aquintutor/labs/pendulum');
ok('internal path recognised', ip.ok && ip.kind === 'internal' && ip.embedUrl === '/aquintutor/labs/pendulum', ip);
const own = resolveVideoLink('https://edurankai.in/aquintutor/labs/optics-bench');
ok('own absolute url becomes an internal path', own.ok && own.kind === 'internal' && own.embedUrl.startsWith('/'), own);
const lo = resolveVideoLink('https://example.org/some/course/page', { allowLinkOut: true });
ok('link-out allowed only when asked for', lo.ok && lo.kind === 'link', lo);
ok('same url refused when link-out not asked for', !resolveVideoLink('https://example.org/some/course/page').ok);

// A meeting invite in a video field gets its own sentence, not the generic one.
const meet = resolveVideoLink('https://meet.google.com/abc-defg-hij');
ok('meeting link refused with its own reason', !meet.ok && /meeting link/i.test(meet.reason), meet);

// --- hardening attributes travel with the result ---------------------------------------------
const y = resolveVideoLink('https://youtu.be/dQw4w9WgXcQ');
ok('sandbox set on embed', y.ok && y.sandbox.includes('allow-scripts'), y);
ok('sandbox withholds top-navigation', y.ok && !y.sandbox.includes('allow-top-navigation'), y);
ok('sandbox withholds popups', y.ok && !y.sandbox.includes('allow-popups'), y);
ok('allow list is playback only', y.ok && !/camera|microphone|geolocation|payment/.test(y.allow), y);
ok('referrer policy set', y.ok && y.referrerPolicy === 'strict-origin-when-cross-origin', y);

// --- brand names never reach a page ----------------------------------------------------------
const BRANDS = /youtube|vimeo|dailymotion|loom|wistia|google|drive\.google|jit\.si|zoom|teams/i;
for (const [input] of cases) {
  const r = resolveVideoLink(input);
  if (!r.ok) continue;
  ok('description is brand-free for ' + input.slice(0, 34), !BRANDS.test(r.description), r.description);
  ok('describeVideoLink is brand-free for ' + input.slice(0, 30), !BRANDS.test(describeVideoLink(r)), describeVideoLink(r));
}
for (const bad of ['javascript:alert(1)', 'http://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/@channel', 'https://example.org/x']) {
  const r = resolveVideoLink(bad);
  ok('refusal sentence is brand-free: ' + bad.slice(0, 26), !r.ok && !BRANDS.test(r.reason), !r.ok ? r.reason : '');
}

// --- storage round-trip ------------------------------------------------------------------------
const v = videoColumnValues(resolveVideoLink('https://youtu.be/dQw4w9WgXcQ'));
ok('original stored as pasted', v.video_url === 'https://youtu.be/dQw4w9WgXcQ', v);
ok('derived embed stored too', !!v.video_embed_url && v.video_embed_url !== v.video_url, v);
ok('kind stored', v.video_link_kind === 'embed', v);

// Render re-derives from the original, so a change to how we build embeds reaches old rows.
const stored = resolveStoredVideo('https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ');
ok('render prefers a fresh derivation', stored.ok && stored.embedUrl.includes('youtube-nocookie'), stored);

// A row whose stored ORIGINAL is hostile is not rescued by its stored derived column.
const poisoned = resolveStoredVideo('javascript:alert(1)', 'javascript:alert(1)');
ok('poisoned row refused at render', !poisoned.ok, poisoned);

// A row saved under an older allowlist still renders from its derived column, re-validated.
const legacy = resolveStoredVideo('https://old-host.example/watch/9', 'https://player.vimeo.com/video/123456789');
ok('legacy row falls back to a re-validated derived url', legacy.ok && legacy.kind === 'embed', legacy);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
