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

  /**
   * The three globals published by public/webauthn-client.js, which the sign-in pages and the
   * security panel load with `is:inline` before any script that calls them.
   *
   * Declared here with the signatures that file actually assigns - not `any` - so a caller reading
   * a field our own /api/2fa/passkey/* endpoints never return is a compile error rather than an
   * `undefined` that quietly does nothing on an authentication path.
   */
  interface Window {
    /** True when this browser exposes the WebAuthn APIs the helpers need. Never a promise. */
    eraPasskeySupported: boolean;
    /**
     * Enrol a new passkey for the signed-in user, naming the device. Resolves only on a verified
     * registration; every refusal - from the server or from the authenticator - is a rejection.
     */
    eraPasskeyRegister(name?: string): Promise<{ ok: true; id: string }>;
    /**
     * Passwordless sign-in with a discoverable passkey. Resolves with where to go next; `pending`
     * marks a session that still has a second step to clear, so the caller must follow `redirect`
     * rather than treat the resolve as "signed in".
     */
    eraPasskeyLogin(): Promise<{ ok: true; pending?: boolean; redirect?: string }>;
  }
}

export {};
