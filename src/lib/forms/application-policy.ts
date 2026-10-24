const TERMINAL_STATUSES = new Set(['withdrawn', 'rejected']);
export const APPLICATION_COOLING_MS = 180 * 24 * 60 * 60 * 1000;

export type PriorApplication = {
  id: string;
  status: string;
  created_at: string | Date;
  updated_at?: string | Date | null;
};

export type PriorApplicationDecision =
  | { kind: 'allow' }
  | { kind: 'duplicate'; applicationId: string }
  | { kind: 'cooling' };

export function decidePriorApplication(
  prior: PriorApplication | PriorApplication[] | null,
  now = Date.now(),
): PriorApplicationDecision {
  const applications = (Array.isArray(prior) ? prior : prior ? [prior] : [])
    .filter((application) => application && application.id && application.status);
  if (applications.length === 0) return { kind: 'allow' };

  const active = applications.find((application) => !TERMINAL_STATUSES.has(String(application.status)));
  if (active) {
    return { kind: 'duplicate', applicationId: String(active.id) };
  }

  const mostRecent = applications.reduce((latest, application) => {
    const latestAt = new Date(latest.updated_at || latest.created_at).getTime();
    const applicationAt = new Date(application.updated_at || application.created_at).getTime();
    return applicationAt > latestAt ? application : latest;
  });
  const endedAt = new Date(mostRecent.updated_at || mostRecent.created_at).getTime();
  if (!Number.isFinite(endedAt) || now < endedAt + APPLICATION_COOLING_MS) {
    return { kind: 'cooling' };
  }
  return { kind: 'allow' };
}

export function splitApplicantName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  return {
    firstName: (parts.shift() || 'Applicant').slice(0, 100),
    lastName: (parts.join(' ') || 'Applicant').slice(0, 100),
  };
}
