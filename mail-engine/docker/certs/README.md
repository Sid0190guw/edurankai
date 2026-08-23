# mail-engine/docker/certs — TLS material for Postfix and Dovecot

**Nothing real in here is committed.** `.gitignore` excludes `mail-engine/docker/certs/`; this README
and `.gitkeep` exist so the directory is present before the first `docker compose up`, because a bind
mount of a path that does not exist gets created by the daemon as a root-owned directory, and then
nothing inside the container can write to it.

## What the containers expect

    fullchain.pem    certificate + intermediates
    privkey.pem      the private key, mode 0600

## Development

Leave it empty. Both entrypoints generate a self-signed pair on first boot if none is present, and
say clearly in the log that they have done so. Self-signed is fine on a laptop and **wrong in
production**: other mail servers fall back to cleartext rather than trust it.

## Production

Put real certificates here — Let's Encrypt, via the procedure in `../../docs/production-migration.md`
— and add the copy step to the renewal hook. A certificate that expires silently degrades every
connection to cleartext without anything appearing to break.

If you prefer to mount this directory read-only in production (a reasonable posture for material you
manage outside the stack), that now works: the entrypoints detect an unwritable directory and fall
back to generating into a container-local path instead of crash-looping.
