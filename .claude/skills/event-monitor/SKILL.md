---
name: event-monitor
description: Watch the live 出海官网获客诊断 event funnel on prod (/c access codes, WeChat H5 pay, event code CKGSB, report generation and emails) and step in when something is stuck. Use when asked "现在有人在用吗", "check the event", "monitor prod", "is anything stuck", to switch the event code on or off, or on a scheduled monitoring run.
---

# Event monitor: 出海官网获客诊断

The funnel: QR → `https://gethatchapp.com/c` → form (姓名, 电话, 邮箱, 网址, 出海国家选填) → WeChat H5 pay ¥9.90 **or** an access code → the code's page `/c/<code>` → one diagnosis Run → an HTML report link by email.

- Product `159c0f12-6e23-4512-af7b-928833d199d7` (creator MSC咨询, unlisted).
- Load-test product `e0cd15bc-8d38-4066-be28-29c3e7fe0949` (replay, no model cost). Ignore its rows when reporting.
- One code is one person and one conversation. A used code reopens its own report.
- The event code `CKGSB` (source `event`) is never spent. Entering it issues the person a new free MSC code, and their page is that code's.

## Connect

The credentials come from the environment, never from the repo:
- `HATCH_PROD_HOST`, `HATCH_PROD_USER`
- `HATCH_PROD_SSH_KEY_B64`, `HATCH_PROD_KNOWN_HOSTS_B64`
- `HATCH_AXIOM_TOKEN`, `HATCH_AXIOM_DATASET`, `HATCH_AXIOM_ENDPOINT`
- `RESEND_API_KEY`, `CF_API_TOKEN`

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "$HATCH_PROD_SSH_KEY_B64" | base64 -d > ~/.ssh/hatch_prod && chmod 600 ~/.ssh/hatch_prod
echo "$HATCH_PROD_KNOWN_HOSTS_B64" | base64 -d >> ~/.ssh/known_hosts
cat >> ~/.ssh/config <<EOF
Host hatch-prod
  HostName $HATCH_PROD_HOST
  User $HATCH_PROD_USER
  IdentityFile ~/.ssh/hatch_prod
  IdentitiesOnly yes
EOF
psql_prod() { ssh hatch-prod "docker exec -i hatch-infra-postgres-1 psql -U hatch -d hatch -At -F' | '" ; }
echo "select now()" | psql_prod
```

The containers are `hatch-app-runtime-NNN`, `hatch-app-dashboard-NNN` and `hatch-infra-postgres-1`. Find them with `ssh hatch-prod "docker ps --format '{{.Names}} {{.Status}}'"`.

Never print a secret value. Never paste one into a tool call's output, a file in the repo, or a message.

## Rules during the event

- **Do not deploy the backend** (anything under `runtime-server/**` or `packages/**`, or a push that triggers `Hatch application CD`). A runtime restart interrupts every running diagnosis. The reconciler retries it, but the person waits about 10 minutes longer.
- If a backend deploy is truly unavoidable, run query 2 immediately before the switchover and only proceed when it returns no rows. Tell the user first.
- **Do not spend money.** Don't start real diagnoses to test. Don't run paid load tests; the replay product exists for that.
- **Do not touch payments.** Never call WeChat Pay, refund or create orders. Paid state is read from the DB only.
- Do not edit a person's report, conversation or answers.
- Report to the user in Chinese, with code/terms in English.

## Checks (run these each time)

### 1. Activity: who used what in the last N minutes

```sql
select c.code, c.source, c.status, coalesce(c.outcome,'-') outcome, c.attempts,
  to_char(c.created_at at time zone 'Asia/Shanghai','HH24:MI') created,
  coalesce(to_char(c.used_at at time zone 'Asia/Shanghai','HH24:MI'),'') used,
  coalesce(substring(v.brief_snapshot::text from '"name"[^}]*?"value": ?"([^"]*)"'), c.name, '') name,
  coalesce(substring(v.brief_snapshot::text from '"website"[^}]*?"value": ?"([^"]*)"'), '') website,
  coalesce(substring(v.brief_snapshot::text from '"email"[^}]*?"value": ?"([^"]*)"'), c.email, '') email
from hatch_access_codes c
left join hatch_conversations v on v.owner_account_id = 'code:' || c.code
where c.product_id = '159c0f12-6e23-4512-af7b-928833d199d7'
  and (c.created_at > now() - interval '60 minutes' or c.used_at > now() - interval '60 minutes')
order by greatest(c.created_at, coalesce(c.used_at, c.created_at)) desc;
```

How to read a row:
- **source `free`, status `active`, created just now, no `used`**: someone entered CKGSB and got a code but has not submitted the form yet. That is normal, and no cost has been spent.
- **source `paid`, status `pending`**: the pay page opened, but no payment arrived. Normal if they gave up.
- **source `paid`, status `active`**: paid but the form is not submitted yet (H5 returns to the page, which submits it). If it has stayed like this for more than 5 minutes, see "Stuck" below.
- **status `used`, outcome `-`**: the diagnosis is running.
- **outcome `ready`**: the report is published and emailed.
- **outcome `failed`**: alert.

Our own test identities are `keithhchen@icloud.com`, `keith@tokenquadrant.cn` and the name `Keith`. Report them separately from real people.

### 2. In flight right now

```sql
select code, attempts, to_char(used_at at time zone 'Asia/Shanghai','HH24:MI') used,
  round(extract(epoch from now() - used_at)/60) minutes,
  coalesce(to_char(next_attempt_at at time zone 'Asia/Shanghai','HH24:MI:SS'),'') next_attempt
from hatch_access_codes
where product_id = '159c0f12-6e23-4512-af7b-928833d199d7' and status = 'used' and outcome is null
order by used_at;
```

### 3. Reports and emails

```sql
select p.id, to_char(p.created_at at time zone 'Asia/Shanghai','HH24:MI') created, p.emailed_at is not null emailed
from hatch_html_pages p
where p.created_at > now() - interval '60 minutes'
order by p.created_at desc;
```

If a column name differs, read the table first with `\d hatch_html_pages`.

For delivery, use Resend: `curl -s -H "Authorization: Bearer $RESEND_API_KEY" "https://api.resend.com/emails?limit=20"`. Look at `last_event`: `delivered` is fine; `bounced` or `complained` is an alert.

### 4. Leads (预约咨询 clicks on a report)

```sql
select to_char(created_at at time zone 'Asia/Shanghai','HH24:MI') at, tier_name, tier_price, buyer_name, buyer_phone, buyer_email, access_code
from hatch_report_leads order by created_at desc limit 20;
```

Leads matter to MSC. Report new ones every time.

### 5. Errors in the logs

Axiom: POST `https://api.axiom.co/v1/datasets/_apl?format=tabular` (header `Authorization: Bearer $HATCH_AXIOM_TOKEN`) with `{"apl":"['$HATCH_AXIOM_DATASET'] | where _time > ago(30m) | where level == 'error' | summarize count() by event | order by count_ desc"}`. `HATCH_AXIOM_ENDPOINT` is the ingest edge and is not for queries.

For a quick look, `ssh hatch-prod "docker logs --since 30m $(docker ps --format '{{.Names}}' | grep runtime | head -1) 2>&1 | grep -i error | tail -20"` also works.

### 6. The site answers

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://gethatchapp.com/c
curl -s https://gethatchapp.com/v1/web-chat/code/CKGSB   # {"state":"event"} while the event is on
```

## When is it stuck

| What | Threshold | Meaning |
|---|---|---|
| Running (query 2) | more than **20 minutes** since `used_at` | A normal run takes 6–13 minutes. The reconciler retries on its own (backoff 10/30/60/120 s, up to 6 attempts), so check `attempts` and `next_attempt` before acting. |
| `attempts` ≥ 4 and still no outcome | | Likely to fail. Alert the user. |
| `outcome = failed` | any | The person sees 「生成遇到问题」. Alert at once, with the code, name, email and website. |
| paid `active`, not used | more than 5 minutes | They paid but the intake did not land. Their page `/c/<code>` still shows the form, and the code email has the link. Alert. |
| report row present, not emailed | more than 2 minutes | The email failed. Alert; the person can still open the report from `/c/<code>`. |
| `/c` not 200, or CKGSB not `{"state":"event"}` while on | | Alert at once. |

Do not restart containers to "fix" a stuck run. The reconciler owns retries. A restart interrupts everyone else who is running.

## Interventions you may do

- **Switch the event code** (takes effect at once, no deploy):
  - Off: `update hatch_access_codes set status='void' where code='CKGSB';`
  - On: `update hatch_access_codes set status='active' where code='CKGSB';`
  - Turning it off never affects codes already issued from it.
- **Add free codes**: `insert into hatch_access_codes(code, product_id, status, source) values ('MSCxxxxxx','159c0f12-6e23-4512-af7b-928833d199d7','active','free');` Use the alphabet 23456789ABCDEFGHJKMNPQRSTUVWXYZ, MSC plus 6 characters.
- **Void one code** (for example a leaked test code): `update hatch_access_codes set status='void' where code='…' and status='active';`

Anything else (re-queueing a failed run, editing prompts, resending an email, touching payments) needs the user's explicit OK in this conversation first.

## Reporting

- If nothing is happening, give one line: the time, 0 running, and the last activity time.
- Otherwise list:
  - real people: name, website, state;
  - our tests, kept separate;
  - new leads;
  - any alert, with what you checked and what you suggest.
- On a scheduled run, notify the user only when something is new or wrong: a new real person, a lead, a failure, something stuck, or the site down. Stay silent otherwise.
