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
  // A TIMESTAMP IN THE PASTED LINK IS NOW KEPT. This case asserted the opposite, because the
  // resolver used to drop it: an author linking to 14:32 of a two-hour lecture meant that minute,
  // and silently sending every learner back to 0:00 is a wrong answer that looks like a right one.
  ['https://youtu.be/dQw4w9WgXcQ?t=42', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&playsinline=1&start=42'],
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

// =================================================================================================
// EVERY SOURCE ADDED WHEN "CAN WE TAKE A VIDEO FROM ANYWHERE?" TURNED OUT TO MEAN SIX PLACES.
//
// One case per shape an author actually pastes. The assertion is on the address WE BUILD, because
// that string is the only one that ever reaches an iframe or a media element.
// =================================================================================================

const built: [string, string, string][] = [
  // label, pasted, expected embed address
  ['playlist becomes a series player', 'https://www.youtube.com/playlist?list=PLabcdefghijklmnopqrst',
    'https://www.youtube-nocookie.com/embed/videoseries?list=PLabcdefghijklmnopqrst&rel=0&modestbranding=1&playsinline=1'],
  ['an hours-minutes-seconds timestamp is converted', 'https://youtu.be/dQw4w9WgXcQ?t=1h2m3s',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&playsinline=1&start=3723'],
  ['public archive item', 'https://archive.org/details/feynman-lectures', 'https://archive.org/embed/feynman-lectures'],
  ['federated platform, short form', 'https://tilvids.com/w/oR3mSHDwCXvHVJvBLZmMLa', 'https://tilvids.com/videos/embed/oR3mSHDwCXvHVJvBLZmMLa'],
  ['federated platform, uuid form', 'https://video.uni.edu/videos/watch/12345678-1234-1234-1234-123456789abc',
    'https://video.uni.edu/videos/embed/12345678-1234-1234-1234-123456789abc'],
  ['lecture capture viewer becomes an embed', 'https://uni.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=12345678-1234-1234-1234-123456789abc',
    'https://uni.hosted.panopto.com/Panopto/Pages/Embed.aspx?id=12345678-1234-1234-1234-123456789abc&autoplay=false&showtitle=false'],
  ['delivery service, shared domain', 'https://videodelivery.net/abcdef1234567890abcdef12', 'https://iframe.videodelivery.net/abcdef1234567890abcdef12'],
  ['delivery service, customer domain', 'https://customer-abc123.cloudflarestream.com/abcdef1234567890abcdef12/iframe',
    'https://customer-abc123.cloudflarestream.com/abcdef1234567890abcdef12/iframe'],
  ['second delivery service', 'https://iframe.mediadelivery.net/play/1234/abcd-efgh-1234-5678-90ab',
    'https://iframe.mediadelivery.net/embed/1234/abcd-efgh-1234-5678-90ab'],
  ['enterprise player address', 'https://players.brightcove.net/1234567890/default_default/index.html?videoId=6301234567',
    'https://players.brightcove.net/1234567890/default_default/index.html?videoId=6301234567'],
  ['business file share becomes an embed path', 'https://acme.app.box.com/s/abcdefgh12345678', 'https://acme.app.box.com/embed/s/abcdefgh12345678'],
  ['regional platform', 'https://www.bilibili.com/video/BV1xx411c7mD', 'https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&autoplay=0'],
];
for (const [label, pasted, expected] of built) {
  const r = resolveVideoLink(pasted);
  ok(label, r.ok && r.embedUrl === expected, r.ok ? r.embedUrl : r);
}

// --- the file-sync service, which is the bug that started this ----------------------------------
//
// Its share address ENDS IN .mp4 AND SERVES AN HTML PAGE. It used to sail through the media-extension
// test and become a <video> pointed at a web page: a black rectangle in the lesson, with nothing
// anywhere saying why. It must now be recognised by host, rewritten to the raw form, and reported as
// a FILE rather than as an iframe.
const sync = resolveVideoLink('https://www.dropbox.com/s/abc123/lecture.mp4?dl=0');
ok('file-sync share is rewritten to the raw form', sync.ok && sync.embedUrl === 'https://www.dropbox.com/s/abc123/lecture.mp4?raw=1', sync);
ok('file-sync share is a media file, not a framed page', sync.ok && sync.kind === 'file' && sync.mediaKind === 'video', sync);
ok('file-sync share warns about sharing', sync.ok && !!sync.warning, sync);
ok('a file-sync folder is refused, not half-accepted', !resolveVideoLink('https://www.dropbox.com/sh/folder123/AAA').ok);

// --- media kinds ---------------------------------------------------------------------------------
const kinds: [string, string, string][] = [
  ['plain video file', 'https://cdn.example.com/v/lecture.mp4', 'video'],
  ['audio-only lesson', 'https://cdn.example.com/a/lecture.mp3', 'audio'],
  ['adaptive stream', 'https://cdn.example.com/s/master.m3u8', 'hls'],
  ['adaptive stream, second format', 'https://cdn.example.com/s/manifest.mpd', 'dash'],
];
for (const [label, url, expected] of kinds) {
  const r = resolveVideoLink(url);
  ok(label + ' is reported as ' + expected, r.ok && r.kind === 'file' && r.mediaKind === expected, r);
}
const hls = resolveVideoLink('https://cdn.example.com/s/master.m3u8');
ok('an adaptive stream declares that it needs a player', hls.ok && hls.needsStreamPlayer === true, hls);
ok('a plain file does not', (() => { const r = resolveVideoLink('https://cdn.example.com/v/x.mp4'); return r.ok && !r.needsStreamPlayer; })());

// --- pages that refuse to be framed ---------------------------------------------------------------
//
// A conferencing service's cloud recording is real and playable, and its page sends a header that
// makes framing impossible. Resolving it to an embed would put an empty rectangle in the lesson, so
// it resolves to a link. And an address on the SAME HOST that is not a recording is still a meeting
// invitation and still gets the meeting sentence — moving the provider loop above that refusal must
// not have cost that.
const rec = resolveVideoLink('https://zoom.us/rec/share/abcDEF123');
ok('a cloud recording resolves to a button, not an empty frame', rec.ok && rec.kind === 'link', rec);
const invite = resolveVideoLink('https://zoom.us/j/1234567890');
ok('a meeting invitation still gets the meeting sentence', !invite.ok && /live session/.test(invite.reason), invite);
ok('an unrelated meeting host still gets it too', (() => { const r = resolveVideoLink('https://meet.google.com/abc-defg-hij'); return !r.ok && /live session/.test(r.reason); })());

// --- second cloud drive: only the embed address can be framed --------------------------------------
const od = resolveVideoLink('https://onedrive.live.com/embed?cid=ABC&resid=ABC%21123&authkey=XYZ');
ok('the embed address is accepted', od.ok && od.kind === 'embed', od);
const odShare = resolveVideoLink('https://onedrive.live.com/?cid=ABC&id=ABC%21123');
ok('the ordinary share address is refused with the instruction, not accepted and broken',
  !odShare.ok && /Embed option/.test(odShare.reason), odShare);
ok('a shortened address is refused the same way', (() => { const r = resolveVideoLink('https://1drv.ms/v/s!AbCdEf'); return !r.ok && /Embed option/.test(r.reason); })());

// --- warnings we cannot check and therefore state ---------------------------------------------------
const drive = resolveVideoLink('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/view?usp=sharing');
ok('a drive file warns that it has to be shared', drive.ok && !!drive.warning && /anyone with the link/i.test(drive.warning), drive);
const enc = resolveVideoLink('https://mega.nz/embed/AbCdEfGh#K3yK3yK3yK3yK3yK3yK3yK');
ok('an encrypted-service address warns that the key is in the link', enc.ok && !!enc.warning && /key/i.test(enc.warning), enc);

// --- the hardening did not loosen -------------------------------------------------------------------
//
// Every new provider builds its own address from an extracted id, so none of them may be a way in.
for (const hostile of [
  'https://archive.org/details/../../etc/passwd',
  'https://tilvids.com/w/<script>',
  'https://random-blog.example/w/aboutus',
  'https://uni.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=javascript:alert(1)',
  'https://players.brightcove.net/abc/def/index.html?videoId=javascript:1',
  'https://acme.app.box.com/s/../embed',
  'https://iframe.mediadelivery.net/embed/notanumber/guid',
  'https://customer-x.cloudflarestream.com/short/iframe',
  'https://mega.nz/embed/AbCdEfGh',
]) {
  const r = resolveVideoLink(hostile);
  ok('hostile shape refused or safely rebuilt: ' + hostile.slice(8, 46),
    !r.ok || (!/[<>"']/.test(r.embedUrl) && !/javascript:/i.test(r.embedUrl) && r.embedUrl.startsWith('https://')), r);
}

// Every new provider's description is still brand-free.
for (const url of [
  'https://archive.org/details/feynman-lectures', 'https://tilvids.com/w/oR3mSHDwCXvHVJvBLZmMLa',
  'https://uni.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=12345678-1234-1234-1234-123456789abc',
  'https://acme.app.box.com/s/abcdefgh12345678', 'https://www.bilibili.com/video/BV1xx411c7mD',
  'https://zoom.us/rec/share/abcDEF123', 'https://cdn.example.com/a/x.mp3',
]) {
  const r = resolveVideoLink(url);
  ok('description is brand-free: ' + url.slice(8, 40), r.ok && !BRANDS.test(r.description), r.ok ? r.description : r);
}

// =================================================================================================
// THE THINGS AN ADVERSARIAL AUDIT CONFIRMED WERE WRONG, EACH PINNED BY A TEST.
// =================================================================================================

// 1. A LIVE EVENT AND A SHOWCASE CARRY NUMERIC IDS TOO, and the segment scan matched them, so both
//    saved cleanly as an ordinary single-video player pointed at an id that is not a video's. That
//    is the worst class of wrong answer here: not a refusal an author can act on, but a lesson that
//    saves without complaint and plays nothing.
const ev = resolveVideoLink('https://vimeo.com/event/123456789');
ok('a live event gets the event player, not the video player', ev.ok && ev.embedUrl === 'https://vimeo.com/event/123456789/embed', ev);
const show = resolveVideoLink('https://vimeo.com/showcase/987654321');
ok('a showcase gets the showcase player', show.ok && show.embedUrl === 'https://vimeo.com/showcase/987654321/embed', show);
ok('an ordinary video is unaffected by those two branches',
  (() => { const r = resolveVideoLink('https://vimeo.com/123456789'); return r.ok && r.embedUrl === 'https://player.vimeo.com/video/123456789'; })());

// 2. A SHORT OR ALL-DIGIT PRIVACY HASH WAS SILENTLY DROPPED, which turns an unlisted video into a
//    player that says "private", with nothing anywhere saying a hash had been thrown away.
const shortHash = resolveVideoLink('https://vimeo.com/123456789/ab12');
ok('a four-character privacy hash survives', shortHash.ok && shortHash.embedUrl.endsWith('?h=ab12'), shortHash);
const digitHash = resolveVideoLink('https://vimeo.com/123456789?h=012345');
ok('an all-digit privacy hash survives', digitHash.ok && digitHash.embedUrl.endsWith('?h=012345'), digitHash);

// 3. "SAVE IT AS A LINK THAT OPENS ELSEWHERE" DID NOTHING ON A RECOGNISED HOST — the provider loop
//    returned before anything read the option, so the author ticked a box that changed nothing. A
//    channel page is the commonest case of exactly that.
const chan = resolveVideoLink('https://www.youtube.com/@somechannel', { allowLinkOut: true });
ok('opens-elsewhere now rescues a recognised host', chan.ok && chan.kind === 'link', chan);
ok('and still refuses it when nobody asked for that', !resolveVideoLink('https://www.youtube.com/@somechannel').ok);
ok('a page we will not frame either way is still never framed',
  (() => { const r = resolveVideoLink('https://zoom.us/j/1234567890', { allowLinkOut: true }); return !r.ok || r.kind === 'link'; })());

// 4. A FRAGMENT IS PART OF A DEEP LINK. The path form refused it outright and the absolute form
//    silently dropped it, so the same address behaved differently depending on how it was pasted.
const frag = resolveVideoLink('/aquintutor/labs/optics-bench#lens-2');
ok('an internal deep link keeps its fragment', frag.ok && frag.embedUrl === '/aquintutor/labs/optics-bench#lens-2', frag);
const absFrag = resolveVideoLink('https://edurankai.in/aquintutor/labs/optics-bench#lens-2');
ok('the absolute form of the same link keeps it too', absFrag.ok && absFrag.embedUrl === '/aquintutor/labs/optics-bench#lens-2', absFrag);
ok('the charset is no looser than it was', !resolveVideoLink('/labs/x#<script>').ok);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
