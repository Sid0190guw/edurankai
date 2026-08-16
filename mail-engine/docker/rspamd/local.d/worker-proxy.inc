# Milter mode: Postfix talks to rspamd on 11332 and gets back an action per message.
bind_socket = "*:11332";
milter = yes;
timeout = 120s;
upstream "local" {
  default = yes;
  self_scan = yes;
}
