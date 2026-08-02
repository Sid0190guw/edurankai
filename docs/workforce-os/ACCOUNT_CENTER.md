# Account Center — Identity Architecture

Binding addendum to `WORKFORCE_OS_MASTER_SPEC.md`.

## The defect this replaces

`src/components/workforce/BottomNav.astro:104` — the Profile tab points at `/portal/enroll-face`.

Tapping **Profile** opens a camera. That is wrong in three separate ways, and each would be worth
fixing on its own:

1. **It is not what the label promises.** Someone tapping Profile expects to see themselves — their
   role, their manager, their details. A camera is an interruption they did not ask for.
2. **It elevates one security feature to the status of an entire identity subsystem.** Face
   recognition is one authentication method among several. Passkeys, TOTP, recovery codes and
   fingerprint are peers of it, not children of it.
3. **It cannot absorb a new method.** Adding passkeys today means either a second top-level tab or a
   second special case. The navigation would have to change every time authentication does, which is
   the definition of an architecture that does not scale.

`/portal/profile` already exists and is not what the tab opens. That divergence is the bug.

## Architecture

Profile stops being a page and becomes a subsystem, reached at one address.

```
Bottom navigation
  -> /portal/account            Account Center (overview)
       -> Personal
       -> Professional
       -> Organization / Employment / Reporting
       -> Documents
       -> Security
            -> Password
            -> Two-factor authentication
            -> Biometric authentication
                 -> Face recognition   <- enroll / update / remove / reverify
                 -> Fingerprint
            -> Passkeys
            -> Recovery codes, recovery email, recovery phone
            -> Trusted devices / browsers
            -> Active sessions
            -> Login history and security alerts
       -> Notifications / Privacy / Preferences / Accessibility / Appearance / Language
       -> Connected accounts / API tokens
       -> Activity and audit history
       -> Support
```

**Face enrollment is never a destination.** It opens only when the person explicitly chooses Enroll,
Update, Remove or Reverify from Biometric Authentication.

## The property that makes this worth building

A new authentication method must be addable **without touching navigation**. Passkeys, iris,
hardware keys and any future method register under Security > Authentication and appear in place.

If adding a method requires a navigation change, the architecture has failed and should be revised
rather than worked around.

## Design decision — why not simply repoint the tab

Repointing `BottomNav.astro:104` at `/portal/profile` fixes the immediate surprise in one line, and
leaves every structural problem intact: security features stay scattered, there is still no single
identity surface, and the next authentication method still forces a navigation decision.

The tab is repointed **and** the Account Center is built. The one-line fix ships first because a
camera opening unbidden is a live problem; it is not the resolution.

## Data sources — what exists today

Per the authorization-first rule, a section renders only if its data source exists.

| Section | Source | Status |
|---|---|---|
| Overview: name, designation, department, employee code, joining date | `hr_employees` | Buildable now |
| Reporting manager | `hr_employees.reporting_manager_id` (a USERS id) | Buildable now |
| Email, account status | `users` — note the column is `name`, **never** `full_name` | Buildable now |
| Face recognition | `user_face_enrollments` | Buildable now |
| Two-factor / TOTP | existing 2FA tables | Buildable now |
| Passkeys | WebAuthn tables (self-built, no external library) | Buildable now |
| Active sessions | `sessions` — the most reliable identity table in the system | Buildable now |
| Documents | `hr_onboarding_documents` — share links only, never uploads | Buildable now |
| Audit history | `audit_log`; own-access history via `accessHistoryFor()` | Buildable now |
| Login history | no table records login events; `users.last_login_at` holds only the most recent, and `/admin/login` does not write it | **Needs migration** |
| Trusted devices / browsers | no table | **Needs migration** |
| Connected accounts, API tokens, developer settings | no table | **Needs migration** |
| Security score | derived, and only from sources above | Computed — after those exist |

**Needs-migration sections are not rendered.** No empty card, no zero, no "coming soon". They are
recorded here and absent from the product until the table exists.

## Privacy constraints

- Salary, PAN, Aadhaar, UAN, ESIC and bank fields are **not** on the Account Center unless the viewer
  holds the corresponding capability. They live on `hr_employees` and a `SELECT *` would hand all of
  them to the page.
- Wellness data never appears here in any form. It is women-only, gated server-side, and the Account
  Center has no capability that could reach it.
- Own-access history (`accessHistoryFor()`) **is** shown: a person is entitled to see who read their
  records. That is the subject-facing half of the legal-hold promise.

## Acceptance criteria

- Tapping Profile opens the Account Center overview. It never opens a camera.
- Face recognition is reachable only via Account Center → Security → Biometric Authentication.
- A new authentication method can be added without a navigation change.
- No section renders without a verified data source.
- No sensitive field renders without its capability.

## Implementation order

1. Repoint `BottomNav.astro:104` to `/portal/account` — stops the camera surprise.
2. Build `/portal/account` overview from Buildable-now sources only.
3. Build `/portal/account/security` grouping password, 2FA, passkeys, biometrics, sessions.
4. Move face enrollment behind Security → Biometric Authentication; keep `/portal/enroll-face`
   working as the action target so existing links do not break.
5. Add remaining sections as their data sources become real.
