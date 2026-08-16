# mail-engine/docker/dovecot/default.sieve — file flagged mail into Spam instead of the inbox.
#
# rspamd has already scored the message and written its verdict into a header. This turns that
# verdict into a filing decision. It deliberately does NOT delete anything: a false positive that
# lands in Spam is recoverable, and a false positive that was deleted is a lost message.
require ["fileinto", "mailbox"];

if header :contains "X-Spam-Flag" "YES" {
  fileinto :create "Spam";
  stop;
}
if header :contains "X-Spamd-Action" ["reject", "add header", "rewrite subject"] {
  fileinto :create "Spam";
  stop;
}
