import { describe, expect, it } from 'vitest';
import { UPCOMING, upcomingFeature, upcomingForPath } from './upcoming';

describe('upcoming feature gates', () => {
  it('does not block the real Mail routes', () => {
    expect(UPCOMING.some((feature) => feature.key === 'mail')).toBe(false);
    expect(upcomingFeature('mail')).toBeNull();
    expect(upcomingForPath('/portal/mail')).toBeNull();
    expect(upcomingForPath('/admin/mail')).toBeNull();
    expect(upcomingForPath('/portal/employee/mail')).toBeNull();
  });

  it('does not block the Forms entry and public responder routes', () => {
    expect(UPCOMING.some((feature) => feature.key === 'forms')).toBe(false);
    expect(upcomingFeature('forms')).toBeNull();
    expect(upcomingForPath('/f')).toBeNull();
    expect(upcomingForPath('/f/application-form-spring')).toBeNull();
  });
});
