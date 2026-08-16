# DNS timeouts kept short: a slow blocklist lookup must not hold an SMTP connection open long enough
# for the sending server to give up on us.
dns {
  timeout = 1s;
  sockets = 16;
  retransmits = 2;
}
