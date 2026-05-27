// Event artifact (certificate / award / letter / LOR) helpers.
// Artifacts are issued per participant per level of an event series. Each is
// verifiable (serial + integrity hash) and shareable (share_token -> /c/<token>).

import { randomBytes, createHash } from 'node:crypto';

export type ArtifactType =
  | 'participation'
  | 'completion'
  | 'selection'
  | 'award'
  | 'certificate'
  | 'lor';

export const ARTIFACT_TYPES: ArtifactType[] = [
  'participation', 'completion', 'selection', 'award', 'certificate', 'lor',
];

// Default human title per artifact type.
export const ARTIFACT_TITLES: Record<ArtifactType, string> = {
  participation: 'Certificate of Participation',
  completion: 'Certificate of Completion',
  selection: 'Letter of Selection',
  award: 'Certificate of Award',
  certificate: 'Certificate',
  lor: 'Letter of Recommendation',
};

// Short label for chips / lists.
export const ARTIFACT_LABELS: Record<ArtifactType, string> = {
  participation: 'Participation',
  completion: 'Completion',
  selection: 'Selection',
  award: 'Award',
  certificate: 'Certificate',
  lor: 'LOR',
};

export function isArtifactType(s: any): s is ArtifactType {
  return typeof s === 'string' && (ARTIFACT_TYPES as string[]).includes(s);
}

export function artifactTitle(type: string): string {
  return isArtifactType(type) ? ARTIFACT_TITLES[type] : 'Certificate';
}

// Default citation body, used when the admin does not supply custom wording.
export function defaultArtifactBody(type: ArtifactType, opts: {
  participantName: string; eventTitle: string; levelName?: string; organiser?: string;
}): string {
  const who = opts.participantName || 'The recipient';
  const at = opts.levelName ? `${opts.eventTitle} (${opts.levelName})` : opts.eventTitle;
  const by = opts.organiser || 'EduRankAI';
  switch (type) {
    case 'participation':
      return `This is to certify that ${who} participated in ${at}, organised by ${by}. We thank them for their engagement and effort.`;
    case 'completion':
      return `This is to certify that ${who} successfully completed ${at}, organised by ${by}, fulfilling all requirements of this stage.`;
    case 'selection':
      return `We are pleased to inform that ${who} has been selected to advance from ${at}, organised by ${by}, on the basis of demonstrated merit.`;
    case 'award':
      return `This is to honour ${who} with an award for outstanding performance in ${at}, organised by ${by}.`;
    case 'lor':
      return `It is my pleasure to recommend ${who}. Through ${at}, organised by ${by}, they demonstrated exceptional ability, character, and commitment, and have my strong recommendation.`;
    case 'certificate':
    default:
      return `This is to certify the achievement of ${who} in ${at}, organised by ${by}.`;
  }
}

// ERA-EVT-YYYY-XXXXXX serial.
export function makeSerial(): string {
  const year = new Date().getFullYear();
  const rand = randomBytes(4).toString('hex').toUpperCase();
  return `ERA-EVT-${year}-${rand}`;
}

// Short URL-safe share token for /c/<token>.
export function makeShareToken(): string {
  return randomBytes(12).toString('base64url');
}

// Deterministic integrity hash over the immutable fields of the artifact.
export function integrityHash(parts: {
  serial: string; participantName: string; eventTitle: string;
  levelName?: string; artifactType: string; issuedAt: string;
}): string {
  const s = [parts.serial, parts.participantName, parts.eventTitle, parts.levelName || '', parts.artifactType, parts.issuedAt].join('|');
  return createHash('sha256').update(s).digest('hex').slice(0, 24).toUpperCase();
}
