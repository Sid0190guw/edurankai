# Where a lesson's video can come from

Everything about media on this platform goes through one function: `resolveVideoLink()` in
[src/lib/video-embed.ts](../src/lib/video-embed.ts). A user-supplied string is **never** interpolated
into an iframe or a media element. The resolver parses the URL, requires https, matches the host and
path against an allowlist of known shapes, extracts an id whose character set it constrains, and
**builds the embed address itself** from that id. Anything unmatched is refused at the point of entry
with a sentence saying why.

Provider ids are an internal enum. They must never reach a page anybody reads — user-facing strings
come from the generic `description` field. There is no printed list of supported services anywhere in
the product for the same reason; `/aquintutor/admin/lms/media` is a live checker instead, and it is
always current.

## Can a video file be uploaded?

**Yes, since this change — through the browser, straight to object storage, and only when
S3-compatible storage is configured.**

The reason it did not work before is worth keeping written down. Posting a file to a serverless
function means the whole file travels inside one request that the function receives, and that request
has a body ceiling of a few megabytes on this host. A forty-minute lecture is three orders of
magnitude past it. Chunking inside the function does not help: the ceiling is on the request.

So the bytes no longer come through the server at all.

1. `POST /api/aquintutor/lms/upload-url` — checks the caller has a teaching claim on the course,
   checks extension, declared type and size, chooses the object key itself, and signs a PUT for that
   one key valid for fifteen minutes (`presignedUpload()` in [src/lib/storage.ts](../src/lib/storage.ts)).
2. The browser PUTs the file directly to storage, with a progress bar.
3. The resulting public address is a plain media file on https — which is exactly what the link
   resolver already accepts, so an upload and a pasted link converge on one code path.

Limits: 5 GB, video or audio, extensions `mp4 m4v mov webm ogv mp3 m4a wav opus flac`. Raise the cap
deliberately in `MAX_BYTES`, not by accident.

**Configuration.** Set `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
(optionally `S3_REGION`, `S3_PUBLIC_BASE_URL`) at any S3-compatible bucket — MinIO, Supabase Storage,
R2, or AWS. Signing is SigV4 written with `node:crypto`; no vendor SDK, no new dependency.
With only `BLOB_READ_WRITE_TOKEN` set, storage exists but direct browser upload does **not** work,
because that vendor's client-upload flow needs its browser library, which this project does not
install. `directUploadStatus()` reports that difference honestly and the admin screen prints it.

## What resolves today

Grouped by what the learner ends up with, not by brand.

**Framed players** (a sandboxed iframe whose address we build)

| Kind of source | Address shapes accepted |
| --- | --- |
| The large public platform | `/watch?v=`, `youtu.be/<id>`, `/embed/`, `/v/`, `/shorts/`, `/live/`, and `/playlist?list=` |
| A video hosting service | `/<digits>`, `/video/<digits>`, `/channels/x/<digits>`, unlisted `/<digits>/<hash>`, `?h=` |
| A second public platform | `/video/<id>`, `/embed/video/<id>`, the short host |
| A screen-recording service | `/share/<hex32>`, `/embed/<hex32>` |
| A business video host | `/medias/<id>`, `/iframe/<id>` |
| A shared drive | `/file/d/<id>/view`, `?id=<id>` |
| A public media archive | `/details/<item>`, `/details/<item>/<file>` |
| A federated, self-hosted platform | `/w/<id>`, `/videos/watch/<uuid>` on **any** host |
| An institutional lecture-capture system | `/Panopto/Pages/Viewer.aspx?id=<guid>` on any institution subdomain |
| A live-streaming platform | `/videos/<digits>`, `/clip/<slug>` |
| A large regional platform | `/video/BV<id>` |
| Two developer delivery services | customer subdomain `/<uid>/iframe`, shared `/<uid>`, and `/embed/<lib>/<guid>` |
| An enterprise video platform | `players.../<account>/<player>/index.html?videoId=<id>` |
| A second cloud drive | the address from the file's own **Embed** option, and `embed.aspx?UniqueId=` |
| A business file-sharing service | `/s/<token>` (rewritten to `/embed/s/<token>`) |
| An end-to-end encrypted service | `/embed/<id>#<key>` |

**Media elements** (no script context at all)

- video files: `mp4 m4v webm ogv ogg mov`
- audio files: `mp3 m4a aac wav flac opus oga weba` — rendered in `<audio>`, not in a `<video>`
- adaptive streams: `.m3u8`, `.mpd` — flagged `needsStreamPlayer`
- a file-sync service's share link, rewritten to its raw form

**Buttons** (the page refuses to be framed, so an honest link beats an empty rectangle)

- a conferencing service's cloud recording (`/rec/...`)
- anything the author explicitly saves as "opens elsewhere"

**Same-origin**: a leading-slash path, or an absolute address on our own host, for our own labs and
rooms.

## Deliberate refusals

- **Meeting invitations.** They expire and they send learners into an empty room. A *recording* of
  that meeting is accepted; the invitation is not.
- **Channels, playlists-as-search, folders.** A folder is not a video.
- **The ordinary share address of the second cloud drive**, including its shortened form — only the
  Embed address can be framed, and the refusal says exactly that instead of accepting it and
  rendering a sign-in wall inside the lesson.
- **Everything not https**, addresses with credentials in them, IP literals, loopback and private
  names.

## Known limits on the upload path

Found by an adversarial audit of this change and left open deliberately, so they are written down
rather than discovered:

- **The bucket must be publicly readable.** A signed PUT proves the bucket is *writable by us* and
  says nothing about whether a learner can read the object. The uploader therefore reads the file
  back through a media element after uploading and reports what it finds; do not remove that check.
- **Path-style addressing only.** The signer builds `endpoint/bucket/key`. MinIO, R2, Supabase
  Storage and AWS-in-path-style all accept that; a virtual-hosted-only endpoint does not.
- **No delete, and no object-key column.** Uploads accumulate with no lifecycle sweep and are
  tracked only as a URL string, so nothing can enumerate what a course owns in the bucket. A 5 GB
  cap with no delete is an unbounded bill — worth closing before this is used at volume.
- **No pipeline.** No transcode, no adaptive ladder, no thumbnail, no duration read, no captions.
  An uploaded file is served exactly as it was uploaded.
- **`src/lib/providers/video.ts` is orphaned** and declares a conflicting 4 MB inline-upload
  contract. Nothing imports it; it now carries a note pointing at the presigned route. Wire it up or
  delete it, but do not let both contracts stand.

## Two honest limits

**Sharing settings are invisible from here.** A drive file that plays for its owner and for nobody
else is the most common way a lesson video "does not work", and we cannot open somebody's file to
check. So where a precondition applies the resolver returns a `warning` sentence and the form prints
it verbatim.

**No player library is installed.** An adaptive stream plays natively on some browsers and not on
others. Rather than pretend, the resolver sets `needsStreamPlayer` and every player emits the
open-in-a-new-tab fallback next to the element. Adding a streaming player library would fix this and
is a real dependency decision, not a silent one.

## Surfaces

- `/aquintutor/admin/lms/media` — check any address, see what a learner gets, upload a file
- `POST /api/admin/video-link/check` — the same check as JSON, used by the lesson forms
- `POST /api/aquintutor/lms/upload-url` — authorise one direct upload
- Players: the AquinTutor lesson player, the portal course player, and the events page all render
  from the resolver's answer and all handle audio and streams.

Tests: [src/lib/video-embed.test.ts](../src/lib/video-embed.test.ts) — 121 assertions, including one
per new source shape, the hostile-input set, and a check that every description stays brand-free.
