# Fly service retirement — VO-3185

On 2026-10-21, card VO-3185 (`t_5fbdebec`, run 1922) stopped the unused Fly service(s) **discord-pm** under the owner's instruction to stop services we are not using.

The live internal endpoint returned zero active sessions. The retained database held 177 standups, last ended 2026-07-08T16:44:29.765Z, and zero active sessions; no edge HTTP response series was present over seven days. Machine `2871537be96168` now reads back stopped, with HTTP autostart disabled, minimum zero and restart policy `no`. Volume `discord_pm_data` (`vol_vx2po99xdlng21wr`) remains mounted and retained.

The launch manifest `fly.toml` was removed to prevent a routine deploy from recreating the retired service. The saved pre-act machine configurations, exact update commands and provider readbacks are on the volter-org card under `home/kanban/artifacts/t_5fbdebec/r1922/`. Configuration evidence omits credential values. All existing data and volumes are retained; no app, database, account, domain, mail or registration was deleted or changed.

Reactivation is a deliberate service decision: read the retained state and consumers again, restore an appropriate deployment configuration through review, and obtain the provider-act permission the organization requires. Restoring a config or removing a preview's retirement label is not routine maintenance.

`scripts/deploy.sh` now refuses all deploys, including `--force`, with this retirement pointer. The source and retained transcripts remain available.
