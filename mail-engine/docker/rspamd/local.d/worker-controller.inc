# The web UI and the rspamc control channel. Bound to every interface INSIDE the container network
# only; the compose file does not publish this port, and it must never be published without a
# password set here.
bind_socket = "*:11334";
