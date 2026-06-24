# TODOS


## Pending-LC fast-follows (from autoplan 2026-06-24T12:38:14Z)
- [ ] Daily overdue-LC watchdog: scheduled job runs lc_derive.ts, alerts (WhatsApp/in-app) when Delay>0 rows newly cross due-date. Reuses derivation engine. (G2 deferred)
- [ ] Firestore->Supabase contracts sync to back the watchdog + decouple from Elithum uptime. (G3 deferred)
