/** Redacted, stable diagnostics for mail connection failures. Never returns exception text. */
export type MailConnectionStage =
  | 'configuration'
  | 'connection'
  | 'authentication'
  | 'mailbox_selection'
  | 'mailbox_listing'
  | 'message_search'
  | 'message_fetch'
  | 'message_parse'
  | 'message_delivery'
  | 'watermark_persistence'
  | 'logout'
  | 'unknown';

export type MailConnectionDiagnostic = {
  code: string;
  stage: MailConnectionStage;
  detail: string;
  command?: string;
  protocolStatus?: 'NO' | 'BAD';
  protocolCode?: string;
};

export type SmtpConnectionDiagnostic = {
  code: string;
  stage: 'verification';
  detail: string;
};

type ErrorLike = Record<string, any>;

const SAFE_PROTOCOL_CODES = new Set([
  'ALREADYEXISTS', 'AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'BADCHARSET',
  'CANNOT', 'CLOSED', 'EXPUNGEISSUED', 'INUSE', 'LIMIT', 'NONEXISTENT',
  'NOPERM', 'NOTSUPPORTED', 'OVERQUOTA', 'READ-ONLY', 'READ-WRITE', 'TRYCREATE',
  'UNAVAILABLE',
]);

const SAFE_COMMANDS = new Set([
  'APPEND', 'AUTHENTICATE', 'CAPABILITY', 'CHECK', 'CLOSE', 'COPY', 'CREATE',
  'DELETE', 'EXAMINE', 'EXPUNGE', 'FETCH', 'IDLE', 'LIST', 'LOGIN', 'LOGOUT',
  'LSUB', 'MOVE', 'NAMESPACE', 'NOOP', 'RENAME', 'SEARCH', 'SELECT', 'STATUS', 'UID',
  'STORE', 'SUBSCRIBE', 'UNSUBSCRIBE',
]);

function errorChain(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current !== 'object' && typeof current !== 'function') break;
    chain.push(current as ErrorLike);
    current = current.cause;
  }
  return chain;
}

function safeNetworkCode(chain: ErrorLike[]): string | undefined {
  const codes = chain.map((item) => String(item.code || '').toUpperCase());
  if (codes.some((code) => ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_HANDSHAKE_TIMEOUT'].includes(code) || code.startsWith('ERR_TLS_'))) return 'IMAP_TLS_FAILURE';
  if (codes.some((code) => ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].includes(code))) return 'IMAP_DNS_FAILURE';
  if (codes.some((code) => ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code))) return 'IMAP_CONNECTION_TIMEOUT';
  if (codes.some((code) => ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code))) return 'IMAP_CONNECTION_FAILURE';

  // Error messages are inspected only for classification. They are never returned or logged.
  const messages = chain.map((item) => String(item.message || '').toLowerCase());
  if (messages.some((message) => /certificate|self.signed|tls|ssl|wrong version number/.test(message))) return 'IMAP_TLS_FAILURE';
  if (messages.some((message) => /enotfound|eai_again|getaddrinfo|name or service not known/.test(message))) return 'IMAP_DNS_FAILURE';
  if (messages.some((message) => /etimedout|esockettimedout|timed out|timeout/.test(message))) return 'IMAP_CONNECTION_TIMEOUT';
  if (messages.some((message) => /econnrefused|econnreset|ehostunreach|enetunreach|connection refused|socket hang up/.test(message))) return 'IMAP_CONNECTION_FAILURE';
  return undefined;
}

function safeCommand(chain: ErrorLike[]): string | undefined {
  for (const item of chain) {
    const executed = typeof item.executedCommand === 'string' ? item.executedCommand : '';
    if (!executed || executed.length > 2048) continue;
    const tokens = executed.trim().split(/\s+/);
    let index = 0;
    if (!SAFE_COMMANDS.has((tokens[0] || '').toUpperCase()) && /^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(tokens[0] || '')) index = 1;
    const first = (tokens[index] || '').toUpperCase();
    if (first === 'UID') {
      const second = (tokens[index + 1] || '').toUpperCase();
      if (['COPY', 'FETCH', 'MOVE', 'SEARCH', 'STORE'].includes(second)) return 'UID ' + second;
      continue;
    }
    if (SAFE_COMMANDS.has(first)) return first;
  }
  return undefined;
}

function safeProtocolStatus(chain: ErrorLike[]): 'NO' | 'BAD' | undefined {
  for (const item of chain) {
    const status = String(item.responseStatus || item.response?.command || '').toUpperCase();
    if (status === 'NO' || status === 'BAD') return status;
  }
  return undefined;
}

function safeProtocolCode(chain: ErrorLike[]): string | undefined {
  const candidates: unknown[] = [];
  for (const item of chain) {
    candidates.push(item.serverResponseCode, item.responseCode);
    const response = item.response?.response || item.response;
    for (const attribute of response?.attributes || []) {
      for (const section of attribute?.section || []) candidates.push(section?.value);
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const code = candidate.trim().toUpperCase();
    if (SAFE_PROTOCOL_CODES.has(code)) return code;
  }
  return undefined;
}

function detailFor(code: string): string {
  const details: Record<string, string> = {
    IMAP_TLS_FAILURE: 'The IMAP TLS handshake or certificate validation failed.',
    IMAP_DNS_FAILURE: 'The IMAP host name could not be resolved.',
    IMAP_CONNECTION_TIMEOUT: 'The IMAP connection timed out.',
    IMAP_CONNECTION_FAILURE: 'A network connection to the IMAP server could not be established.',
    IMAP_AUTH_REJECTED: 'The IMAP server rejected authentication.',
    IMAP_MAILBOX_REJECTED: 'The IMAP server rejected mailbox selection.',
    IMAP_COMMAND_REJECTED: 'The IMAP server rejected a command.',
    IMAP_CONFIG_READ_FAILED: 'Saved IMAP configuration could not be read.',
    IMAP_NOT_CONFIGURED: 'IMAP settings are incomplete.',
    IMAP_MESSAGE_PARSE_FAILED: 'An inbound message could not be parsed; the poll stopped before advancing past it.',
    IMAP_MESSAGE_PERSISTENCE_FAILED: 'An inbound message could not be stored; the poll stopped before advancing past it.',
    IMAP_WATERMARK_PERSISTENCE_FAILED: 'The IMAP poll could not save its progress marker.',
    IMAP_POLL_TIMEOUT: 'The IMAP poll exceeded its time limit.',
    IMAP_LOGOUT_FAILED: 'The IMAP session could not close cleanly.',
    IMAP_OPERATION_FAILED: 'The IMAP operation failed.',
  };
  return details[code] || details.IMAP_OPERATION_FAILED;
}

/** Converts driver errors into safe diagnostics. Raw messages and command arguments are discarded. */
export function diagnoseImapFailure(error: unknown, fallbackStage: MailConnectionStage = 'unknown'): MailConnectionDiagnostic {
  const chain = errorChain(error);
  const protocolStage = ['connection', 'authentication', 'mailbox_selection', 'mailbox_listing', 'message_search', 'message_fetch', 'unknown'].includes(fallbackStage);
  const command = protocolStage ? safeCommand(chain) : undefined;
  const protocolStatus = protocolStage ? safeProtocolStatus(chain) : undefined;
  const protocolCode = protocolStage ? safeProtocolCode(chain) : undefined;
  const authRejected = protocolStage && (chain.some((item) => ['EAUTH', 'AUTH_FAILED', 'AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED'].includes(String(item.code || '').toUpperCase()))
    || chain.some((item) => /authentication (failed|rejected)|auth (failed|rejected)|invalid credentials|bad credentials|login failed/i.test(String(item.message || ''))));
  let stage = fallbackStage;
  let code = protocolStage ? safeNetworkCode(chain) : undefined;

  if (command === 'LOGIN' || command === 'AUTHENTICATE' || protocolCode === 'AUTHENTICATIONFAILED' || protocolCode === 'AUTHORIZATIONFAILED' || authRejected) {
    stage = 'authentication';
    code = 'IMAP_AUTH_REJECTED';
  } else if (command === 'SELECT' || command === 'EXAMINE') {
    stage = 'mailbox_selection';
    code = 'IMAP_MAILBOX_REJECTED';
  } else if (fallbackStage === 'mailbox_selection' && (protocolStatus || protocolCode)) {
    stage = 'mailbox_selection';
    code = 'IMAP_MAILBOX_REJECTED';
  } else if (!code && (protocolStatus || protocolCode)) {
    code = 'IMAP_COMMAND_REJECTED';
  } else if (!code && fallbackStage === 'message_delivery') {
    code = 'IMAP_MESSAGE_PERSISTENCE_FAILED';
  } else if (!code && fallbackStage === 'watermark_persistence') {
    code = 'IMAP_WATERMARK_PERSISTENCE_FAILED';
  } else if (!code && fallbackStage === 'message_parse') {
    code = 'IMAP_MESSAGE_PARSE_FAILED';
  } else if (!code && fallbackStage === 'logout') {
    code = 'IMAP_LOGOUT_FAILED';
  } else if (!code && fallbackStage === 'connection') {
    code = 'IMAP_OPERATION_FAILED';
  } else if (!code) {
    code = 'IMAP_OPERATION_FAILED';
  }

  return {
    code,
    stage,
    detail: detailFor(code),
    ...(command ? { command } : {}),
    ...(protocolStatus ? { protocolStatus } : {}),
    ...(protocolCode ? { protocolCode } : {}),
  };
}

/** SMTP exception text can contain server-provided data; only stable categories leave this helper. */
export function diagnoseSmtpFailure(error: unknown): SmtpConnectionDiagnostic {
  const chain = errorChain(error);
  const codes = chain.map((item) => String(item.code || '').toUpperCase());
  const messages = chain.map((item) => String(item.message || '').toLowerCase());
  let code = 'SMTP_VERIFY_FAILED';
  if (codes.some((value) => ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(value) || value.startsWith('ERR_TLS_')) || messages.some((value) => /certificate|self.signed|tls|ssl|wrong version number/.test(value))) {
    code = 'SMTP_TLS_FAILURE';
  } else if (codes.some((value) => ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].includes(value)) || messages.some((value) => /enotfound|eai_again|getaddrinfo/.test(value))) {
    code = 'SMTP_DNS_FAILURE';
  } else if (codes.some((value) => ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(value)) || messages.some((value) => /etimedout|timed out|timeout/.test(value))) {
    code = 'SMTP_CONNECTION_TIMEOUT';
  } else if (codes.some((value) => ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(value)) || messages.some((value) => /econnrefused|econnreset|ehostunreach|enetunreach|connection refused|socket hang up/.test(value))) {
    code = 'SMTP_CONNECTION_FAILURE';
  } else if (codes.some((value) => ['EAUTH', 'AUTHENTICATIONFAILED'].includes(value)) || messages.some((value) => /authentication|invalid login|535/.test(value))) {
    code = 'SMTP_AUTH_REJECTED';
  }
  const details: Record<string, string> = {
    SMTP_TLS_FAILURE: 'The SMTP TLS handshake or certificate validation failed.',
    SMTP_DNS_FAILURE: 'The SMTP host name could not be resolved.',
    SMTP_CONNECTION_TIMEOUT: 'The SMTP connection timed out.',
    SMTP_CONNECTION_FAILURE: 'A network connection to the SMTP server could not be established.',
    SMTP_AUTH_REJECTED: 'The SMTP server rejected authentication.',
    SMTP_VERIFY_FAILED: 'SMTP connection verification failed.',
  };
  return { code, stage: 'verification', detail: details[code] };
}
