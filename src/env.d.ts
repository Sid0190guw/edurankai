/// <reference types="astro/client" />

import type { User, Session } from '@/lib/db/schema';

declare global {
  namespace App {
    interface Locals {
      user: User | null;
      session: Session | null;
      /**
       * AquinTutor's OWN principal, resolved from its own cookie and its own aq_* tables.
       *
       * Deliberately a separate field rather than a widening of `user`. They are two identity
       * domains: a person may be signed in to one, both, or neither, and any code that treats one
       * as a fallback for the other is the bridge docs/aquintutor-independence.md exists to forbid.
       *
       * Null until middleware has resolved it, and null on requests with no AquinTutor cookie —
       * which costs no database call at all.
       */
      aquin: import('@/lib/aquin/identity').AquinPrincipal | null;
    }
  }
}

export {};
