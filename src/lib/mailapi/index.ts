// src/lib/mailapi/index.ts — the transactional email platform, in one import.
//
// EduRankAI Mail's developer surface: a send API, versioned templates, idempotency, a message and
// event store, signed webhooks with retries and a dead-letter state, scoped and environment-separated
// API keys, and multi-dimensional rate limiting.
//
// It sits ON TOP of the existing mail stack rather than replacing any of it:
//   src/lib/mail-transport.ts  — the SMTP transport (own server, no third-party HTTP API)
//   src/lib/mail.ts            — mailbox delivery, threading, configuration
//   src/lib/mail-advanced.ts   — the webmail's scheduled sends, labels, rules
//   src/lib/job-queue.ts       — the general background queue
// Campaign and webmail behaviour are untouched.
export * from './schema';
export * from './errors';
export * from './keys';
export * from './ratelimit';
export * from './idempotency';
export * from './render';
export * from './templates';
export * from './suppression';
export * from './messages';
export * from './webhooks';
export * from './tracking';
export * from './validate';
export * from './send';
export { apiRoute, type ApiContext } from './route';
