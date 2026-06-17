# Platform admin bootstrap

New signups **no longer** get an automatic organization. A **platform admin** must create orgs and assign users.

## Grant yourself platform admin (one-time)

1. In the Supabase dashboard: **Authentication → Users**, copy your user **UUID**.

2. Run in **SQL Editor**:

```sql
insert into public.platform_admins (user_id)
values ('PASTE-YOUR-USER-UUID-HERE')
on conflict (user_id) do nothing;
```

3. Sign out and back in in the app. You should see **Admin** in the sidebar and the full org management UI.

## Create organizations and members

- Use **Admin** in the app to create orgs, add notes, upload workbooks, and add members **by email** (the user must already have signed up with that email).

## Security

Only insert into `platform_admins` for trusted staff. This role can read all org data and chats (operational access).
