# Log to the container's stdout, not to a file inside it.
#
# rspamd's shipped rspamd.conf sets `logging { type = "file"; filename = "$LOGDIR/rspamd.log" }`, and
# `-f` only keeps the process in the foreground — it does not redirect logging. Without this file
# every redis failure, greylist decision and per-message verdict went to /var/log/rspamd/rspamd.log,
# which is not a volume, so `docker logs rspamd` was permanently empty and the entire diagnostic
# record was destroyed on every `docker compose down`.
#
# That combines badly with main.cf's `milter_default_action = accept`: a filter that is up but not
# actually scanning delivers everything unfiltered, and with no logs and a healthcheck that only asks
# the controller for stats, nothing anywhere would say so.
type = "console";
level = "info";
