# The web UI and the rspamc control channel.
#
# LOOPBACK ONLY. This was `*:11334`, which is worse than it looks: local.d is MERGED into the shipped
# worker-controller.inc rather than replacing it, and the shipped file carries rspamd's default
# `password = "q1"` alongside `secure_ip = 127.0.0.1`. So the effective configuration was: reachable
# from every container on the mail network, unauthenticated from loopback, and authenticated from
# anywhere else with a password published in rspamd's own documentation. Anything joining the network
# later could read the scan history — senders, recipients and subjects of every message — retrain
# bayes, or write configuration into /var/lib/rspamd.
#
# The only client is the healthcheck in this container, which connects to 127.0.0.1, so binding
# wider bought nothing. If remote access is ever wanted, set explicit `password` and
# `enable_password` values HERE rather than inheriting the default.
bind_socket = "127.0.0.1:11334";
