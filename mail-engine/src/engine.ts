// mail-engine/src/engine.ts — the composition root. The only file that knows how the parts connect.
//
// Everything else in this engine takes its collaborators as constructor arguments, which is what
// makes the test suite able to run a whole delivery — validation, queue, throttle, classification,
// events, retry — against a scripted SMTP server on localhost with no Docker, no DNS and no real
// mailbox anywhere. This file is where the real implementations are chosen instead.

import { loadConfig, configWarnings, type EngineConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { MessageSpool } from './queue/message-spool.js';
import { SubmissionPipeline } from './pipeline.js';
import { DeliveryWorker } from './worker.js';
import { SmtpMailTransport } from './smtp/transport.js';
import { HttpDeliveryEventPublisher } from './publish/http.js';
import { AppInboundProcessor } from './inbound/processor.js';
import { DkimKeyStore } from './dkim.js';
import { MxResolver } from './smtp/mx.js';

export interface Engine {
  config: EngineConfig;
  logger: Logger;
  spool: MessageSpool;
  pipeline: SubmissionPipeline;
  worker: DeliveryWorker;
  transport: SmtpMailTransport;
  publisher: HttpDeliveryEventPublisher;
  inbound: AppInboundProcessor;
  keys: DkimKeyStore;
  mx: MxResolver;
  warnings: string[];
}

export function createEngine(env: NodeJS.ProcessEnv = process.env): Engine {
  const config = loadConfig(env);
  const logger = createLogger({ level: config.logLevel, component: 'mail-engine' });
  const warnings = configWarnings(config);

  // The warnings are printed at startup rather than being left for someone to discover from
  // behaviour. "Nothing is being delivered" is a much cheaper thing to learn from a log line at boot
  // than from a customer three days later.
  for (const w of warnings) logger.warn('configuration', { note: w });

  const spool = new MessageSpool(config.spoolDir);
  const keys = new DkimKeyStore(config.dkimKeyDir, config.dkimSelector);
  const mx = new MxResolver();
  const publisher = new HttpDeliveryEventPublisher({ config, logger });
  const transport = new SmtpMailTransport({ config, logger, mx, keys });
  const pipeline = new SubmissionPipeline({ config, logger, spool, publisher });
  const worker = new DeliveryWorker({ config, logger, spool, transport, publisher });
  const inbound = new AppInboundProcessor({ config, logger, publisher });

  return { config, logger, spool, pipeline, worker, transport, publisher, inbound, keys, mx, warnings };
}
