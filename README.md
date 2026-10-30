# Kettle & Stone waitlist shortlist

When a late opening comes up (a late cancel or a no-show), this tool shows the front desk **up to 3 people from the waitlist who fit it**, in waitlist order, or **nobody**.

- Claude reads each person's waitlist notes once, when the waitlist is imported. Plain rules then pick the names, so the same files always give the same answer.
- Nothing is sent to clients. The desk calls people and books them in Kneadly as usual.
- Screens show name, phone, waitlist line and the opening. Never notes or health details.

The matching rules are in `rules.md`, kept in the project folder one level above this repo.

---

# Put the tool online, then test it

No coding. You sign up for three websites, click, copy and paste. About 30 minutes, done once. After that, staff just open a link.

## Before you start

- **A computer and 30 minutes.** Chrome or Edge works best.
- **The clinic's email**, to sign up for each website.
- **A payment card.** About $46–50 a month in total (Vercel $20, Supabase $25, Claude $1–5).
- **A private note** to paste the keys into as you go. Delete it at the end.

A "key" is a long password that lets the tool talk to another service. **Never email or message a key to anyone.**

## Stage 1 of 5 · Get the tool's code (GitHub)

GitHub is where the tool's code is stored. You need your own copy of it.

1. **Copy the code to your account.** Sign up or sign in at [github.com](https://github.com). Open [github.com/patel24kishan/kettle-stone-shortlist](https://github.com/patel24kishan/kettle-stone-shortlist) and press **Fork**, then **Create fork**. Skip this if it's already your account.

✅ Done when you see **kettle-stone-shortlist** under your own name.

## Stage 2 of 5 · Set up where it keeps its records (Supabase)

Supabase stores the waitlist results and the staff logins, in Canada.

2. **Create a project.** Sign up at [supabase.com](https://supabase.com). Press **New project**, name it `kettle-stone`, choose the region **Canada (Central)**, and pick the **Pro** plan. Wait a minute while it sets up.
3. **Create the tables.** On GitHub, open [`supabase/schema.sql`](supabase/schema.sql) in your copy and press the copy button at its top right. In Supabase, open **SQL Editor** on the left, paste it in, and press **Run**. "Success" means it worked.
4. **Copy three keys into your note.** Go to **Project Settings**, then **API keys**. Copy the **Project URL**, the **anon** key and the **service role** key.
5. **Add a login for each staff member.** Go to **Authentication**, then **Users**, and press **Add user**. Enter their email and a password. Repeat for everyone at the desk.

✅ Done when your note has 3 keys and the Users list shows your staff.

## Stage 3 of 5 · Get the Claude key (Anthropic)

Claude reads the shorthand waitlist notes. This key lets the tool use it.

6. **Create a key and a spending limit.** Sign up at [console.anthropic.com](https://console.anthropic.com) and add the payment card. Go to **API keys**, press **Create key**, and copy it into your note. Then under **Limits**, set a monthly limit of **$10** so it can never cost more.

✅ Done when your note has 4 keys in total.

## Stage 4 of 5 · Put it online (Vercel)

Vercel turns the code into a website with its own link.

7. **Bring in the code.** At [vercel.com](https://vercel.com), press **Sign Up** and choose **Continue with GitHub**. Pick the **Pro** plan (the free one isn't allowed for a business). Press **Add New**, then **Project**, and press **Import** next to **kettle-stone-shortlist**.
8. **Paste in the four keys.** Before pressing anything else, open **Environment Variables**. For each key, type the name exactly as shown, paste the key from your note, and press **Add**.

   | Type this name | Paste this key |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
   | `ANTHROPIC_API_KEY` | Claude key |

9. **Press Deploy.** Wait about 2 minutes. When you see "Congratulations", copy the link (it looks like `kettle-stone-shortlist.vercel.app`) and send it to staff. Then delete your private note.

✅ Done when the link opens a sign-in page.

## Stage 5 of 5 · Test it with the sample files

The sample files are in this repo's [`data/sample`](data/sample) folder. Download these three from GitHub (open each, then press the download button):

- `waitlist-2026-10-21.csv`
- `late-openings-2026-09-21-to-2026-10-17.csv`
- `appointments-2026-09-21-to-2026-10-17.csv`

10. **Sign in.** Open the link and sign in with a staff email and password from step 5.
11. **Load the files.** Click **Waitlist (admin)**. Choose the waitlist, the late openings and the appointments (booking export) file. Set the run date to **Oct 21, 2026** and press **Import and analyse**.

    You should see: **60** waitlist lines read · **30** people ready to match · **20** stale lines · **10** repeat lines merged.
12. **Search every opening.** Click **Search**, pick **All openings from a file**, and press **Search all openings**. Check two openings against Tanya's answers:

    | Opening | You should see |
    |---|---|
    | **O39** · Dave, Thu 2:00 | Shawn Duguay, Luc Bernard, Lise Gautreau |
    | **O40** · Rachel, Thu 4:00 | Nobody |

13. **Try Booked.** On O39, press **Booked** next to Shawn Duguay. He disappears from every other opening. Press **Undo** to put him back.

✅ Done when both openings match. All 44 openings match Tanya's key on these files.

## Daily use

1. Open the link and sign in. Bookmark it.
2. When new files come in, load them in **Waitlist (admin)** with today's date.
3. In **Search**, pick **One opening**, fill it in, and press **Search waitlist**. You'll see up to 3 names, or "nobody".
4. Call the first name. Once you've booked them in Kneadly, press **Booked**. No answer? Call the next. Wrong tap? **Undo**.
5. **Today's openings** shows every late opening for one day. On a shared computer, press **Sign out** when you're done.

## If something goes wrong

| What you see | What to do |
|---|---|
| Vercel says the deploy failed | Check the four names in step 8 are spelled exactly. Fix them in **Settings**, then press **Redeploy**. |
| "Tables not found" | Do step 3 again. It's safe to repeat. |
| People show as "not read" | The Claude key is missing or wrong. Fix it in Vercel, then **Redeploy**. |
| "A file is refused" | Use the file exactly as it came out of Kneadly. Don't open and re-save it. |
| "Please sign in again" | You were signed out. Sign in again. |

Changes pushed to GitHub go live on Vercel automatically.

## Privacy

- Claude receives the note text and line ids only (like `W12`), never a name or phone number.
- Vercel, Supabase and Anthropic all handle client data once the tool is online. Marc's one-page privacy note (New Brunswick's PHIPAA) must cover all three **before any real client data is used**. Until then, use the sample files only.

---

# For developers

**Stack:** Next.js (App Router), TypeScript, Vitest, Supabase, `@anthropic-ai/sdk` (Claude Opus 5.5).

## Run it on your computer

Needs Node.js 20 or newer.

```
npm install
npm run dev
```

Open http://localhost:3000. Without keys it runs offline: records go in `.data/`, there's no login, and it uses the saved readings for the sample waitlist (`data/sample/readings.json`). To add keys, copy `.env.example` to `.env.local` and fill it in. `.env.local` is never committed.

`SHORTLIST_LOGIN_OFF=1` skips the staff login under `npm run dev` only. A built or deployed app ignores it.

## Command-line run (Friday hand-in)

```
npm run shortlist -- run --waitlist friday/waitlist.csv --appointments friday/appointments.csv --openings friday/late-openings.csv --run-date 2026-10-30
```

Writes `results.csv`, `line_verdicts.csv` and `run.json` to `runs/<run-date>/`. Score a run against an answer key:

```
npm run shortlist -- score --results runs/2026-10-30/results.csv --key friday/answer-key.csv
```

## Checks

| Command | What it checks |
|---|---|
| `npm test` | Every unit and integration test (offline, sample files) |
| `npm run check:done` | The build plan's done checks, including a health-word search of every output file |
| `npm run check:claude` | The Claude key, with one small made-up test reading |
| `npm run check:db` | The Supabase connection and tables |

## Settings still open

Each has a default in `src/lib/types.ts` (`DEFAULT_SETTINGS`). Change the rule in `rules.md` first, then the code and its test.

| Question | For now | Setting |
|---|---|---|
| Notice counted from the cancellation, or from 10:30? | From the cancellation | `noticeFrom: 'cancelled'` |
| Can a shorter booking take a longer opening? | Yes | `allowLongerOpening: true` |
| Is notice exactly equal enough? | Yes | `noticeEqualIsEnough: true` |

`CLINIC_TIME_ZONE` is optional and defaults to `America/Moncton`.
