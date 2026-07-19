# DB & index review — hot paths (Prompt AP7b)

Reviewed the query hot paths for the features shipped in this arc. All additive tables self-bootstrap
their indexes. Findings + the indexes that back each hot path:

| Hot path | Query | Index |
|---|---|---|
| Live spec fan-out (SSE) | `edu_board_events WHERE session_id=? AND seq>?` | `edu_board_events_session_idx (session_id, seq)` ✅ |
| Board participants / inspector | `edu_board_participants (session_id, user_id)` PK | PK ✅ |
| Detections inspector | `edu_board_detections WHERE session_id=? ORDER BY id` | `edu_board_detections_session_idx (session_id, id)` ✅ |
| Job claim (worker) | `edu_jobs WHERE status='pending' AND run_after<=now()` | `edu_jobs_claim_idx (status, run_after)` ✅ + `FOR UPDATE SKIP LOCKED` |
| Payment access gate | `edu_course_payments WHERE user_id=? AND course_obj_id=?` | `edu_course_payments_user_idx (user_id, course_obj_id)` ✅ |
| Payment by order | `edu_course_payments WHERE order_id=?` | `edu_course_payments_order_idx (order_id)` ✅ |
| Moderation queue | `edu_mod_queue WHERE status=? ORDER BY id` | `edu_mod_queue_status_idx (status, id)` ✅ |
| VOD list | `kernel_objects WHERE type='AnimationObject'` | `kernel_objects_type_idx` ✅ (filter `metadata.vod` in app) |
| Guardian fan-out | `rbac_guardian_links WHERE minor_user_id=?` | pre-existing ✅ |

**Recommendations (not blocking):**
- VOD/scene lookups filter `metadata->>'vod'` / `metadata->>'sceneSpec'` in the app after a type scan. If
  the AnimationObject table grows large, add a partial index `WHERE (metadata->>'vod')='true'`.
- `edu_i18n_strings (locale, key)` PK covers the override lookups.
- The SSE poll (`eventsSince` every ~1.5s) is the highest-frequency query — the composite
  `(session_id, seq)` index keeps it index-only; watch it under many concurrent live sessions.
- Consider `pg_stat_statements` in production to confirm these are the real top queries under load.
