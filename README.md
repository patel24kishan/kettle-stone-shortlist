# Kettle & Stone waitlist shortlist

A small tool for the front desk. When a late opening comes up (a late cancel or a no-show), it shows **up to 3 people from the waitlist who can take it**, in waitlist order, or **nobody**. If only 1 or 2 people fit, it shows just those.

- Claude reads each person's waitlist notes **once, when the waitlist is imported**, and turns them into plain fields (therapist, length, days, times, notice). Code then checks every quote against the notes. Anything it can't read is marked "unclear" and that person is never offered. Nobody's notes are guessed.
- Plain rules (no AI) pick the names. The same files always give the same names.
- **Nothing is sent to clients.** The tool only suggests. You call people yourself, and you book them in Kneadly as usual.
- The waitlist CSV is never edited. Screens show name, phone, waitlist line and the opening, never notes or health details.

The rules it follows are in [`../rules.md`](../rules.md).

## What you need

- A computer with **Node.js 20 or newer** (check with `node --version`). Get it from https://nodejs.org (the "LTS" version).
- This folder.

## Install and start

Open a terminal in this folder, then:

```
npm install
npm run dev
```

Open **http://localhost:3000** in the browser. Leave the terminal open while you use the tool; press Ctrl+C in it to stop.

Without any keys the tool works fully offline on this computer: it keeps its records in the `.data/` folder, has no login, and uses the saved readings for the sample waitlist. The sections "Connect Claude" and "Connect Supabase" below add the rest.

## Daily use

1. **Waitlist (admin):** choose the three files as they come (waitlist CSV, late openings CSV, booking export CSV), set the run date, press **Import and analyse**. You see how many lines were read, who is ready to match, which lines were merged as repeats, and "Not offered, and why" for stale people. Each file gets a column check first.
2. **Search:**
   - **One opening:** date, start time, therapist, length and when it was cancelled. Press **Search waitlist**.
   - **All openings from a file:** pick a late openings CSV (or use the imported one) and press **Search all openings**. You can download `results.csv`.
3. **Call** the first person. If they say yes and you've booked them in Kneadly, press **Booked**. They come off every other opening straight away, on every open screen. **Undo** is there for a wrong tap. If they say no or don't answer, do nothing and call the next card.
4. **Today's openings:** every late opening for one day, each with its names. Booked works here too.
5. **Week schedule** shows made-up sample data only. It is a picture of what a schedule view could look like; it does not read your files.

On Josée's openings the screen shows "Josée wants to see who it is first." Every screen shows the date of the booking export, because "booked since" is only as current as that file.

## Friday hand-in steps

Put the three new files anywhere (for example in a `friday/` folder) and run, with the run date of the hand-in:

```
npm run shortlist -- run --waitlist friday/waitlist-2026-10-30.csv --appointments friday/appointments-2026-09-21-to-2026-10-29.csv --openings friday/late-openings-2026-10-26-to-2026-10-31.csv --run-date 2026-10-30
```

It writes three files to `runs/<run-date>/`:

- `results.csv`: for each opening, up to 3 names with phone and waitlist line, or `none`.
- `line_verdicts.csv`: every waitlist line with `active`, `stale` or `duplicate of Wxx`, and the reason.
- `run.json`: the input file names and fingerprints, the settings and the counts.

Command-line runs always start with no Booked marks, so practice clicks in the app never change a run. If the output says some people were "not read", see Troubleshooting.

When an answer key is available, score the run:

```
npm run shortlist -- score --results runs/2026-10-30/results.csv --key friday/answer-key.csv
```

It prints each opening as match / MISMATCH and the totals ("Openings: 10/10 match (Friday rule)", "Lines: …").

Before handing in, run the done checks (the build plan's checklist, all in one go, on the sample files, offline):

```
npm run check:done
```

Every line should start with ✅. It exits with an error if any check fails, and keeps its temp folder so you can look.

## Connect Claude

Claude is only needed when the waitlist has people the tool has not read before. The sample waitlist is already read.

1. Go to https://console.anthropic.com and sign in (or create the clinic's account).
2. **Settings > API keys > Create key.** Copy it.
3. **Settings > Limits:** set a monthly spend limit (for example $10). One import of a 60-line waitlist reads each new person once; repeat imports reuse the saved readings.
4. Open the file `.env.local` in this folder yourself (copy `.env.example` to `.env.local` if it isn't there) and paste the key after `ANTHROPIC_API_KEY=`. **Never paste the key into a chat, an email or anywhere else.**
5. Check it:

   ```
   npm run check:claude
   ```

   With no key it says the app uses saved readings only. With a key it sends **one** small test reading (a made-up line, no client data) and prints OK with the model, the tokens used and the cost (about 1 to 3 cents), or the exact problem and what to do. It never prints the key.
6. Restart `npm run dev`, then import the waitlist again.

## Connect Supabase (for hosting)

Supabase holds the tool's records when it runs on the internet, and gives the staff login and the live updates between devices. Until it is set up, the tool uses the local `.data/` folder with no login.

1. At https://supabase.com create a project in the region **Canada (Central)**.
2. In **Project Settings > API keys**, copy the project URL, the **anon** key and the **service role** key into `.env.local`:

   ```
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...
   ```

   The service role key opens everything: keep it only in `.env.local` and in Vercel's settings.
3. Open the **SQL editor**, paste the whole of `supabase/schema.sql` and run it (it is safe to run again).
4. Under **Authentication > Users**, add a login for each staff member.
5. Restart `npm run dev` (or run `npm run build` again: the URL and anon key are built into the app).
6. Check it:

   ```
   npm run check:db
   ```

**On Vercel:** add the same variables (`ANTHROPIC_API_KEY`, the three Supabase ones and, if you want, `CLINIC_TIME_ZONE`) under **Settings > Environment Variables before deploying**. The saved sample readings ship with the app.

`CLINIC_TIME_ZONE` is optional. Leave it out for New Brunswick time (`America/Moncton`). It only changes the app's own clock ("today", "cancelled at: now", when Booked was pressed); times in the files are used as written.

## Privacy

- **What goes to Anthropic (Claude):** the note text and the line ids only (like `W12`). Never a name or a phone number. Notes can contain health details, so this matters.
- **Vercel, Supabase and Anthropic all handle client data** once the tool is hosted and connected. Marc's one-page note for the clinic (New Brunswick health privacy law, PHIPAA) must cover all three **before any real client data is used**. Until then, use the sample files only.
- No screen or output file shows notes or health details: only name, phone, waitlist line and the opening. `npm run check:done` searches every output file for health words to make sure.

## Rules and settings

The matching rules are in [`../rules.md`](../rules.md). Change that file first, then the code and its test.

Three choices are still open. Each has a "for now" setting in `src/lib/types.ts` (`DEFAULT_SETTINGS`):

| Question | For now | Setting |
|---|---|---|
| Is notice counted from the cancellation, or from 10:30 when the desk is free? | From the cancellation | `noticeFrom: 'cancelled'` |
| Can someone who asked for a shorter booking take a longer opening? | Yes | `allowLongerOpening: true` |
| Is notice exactly equal to what the person needs enough? | Yes | `noticeEqualIsEnough: true` |

After changing one, run `npm test` and the scorer again.

## Troubleshooting

- **People show as "not read"** (in Waitlist (admin) or as a WARNING from the command): they have no saved reading, so they are never offered. Connect Claude (above), then import again (or run the command again).
- **A file is refused:** the message names the file and the missing column(s), for example "The late openings file is missing column(s): cancelled_at." Fix the export so it has the usual columns; the tool never edits your files.
- **The app shows errors after a big change to the files in this folder:** stop `npm run dev` (Ctrl+C), delete the `.next` folder, and start `npm run dev` again.
- **"Please sign in again"** on a hosted copy: the staff login expired. Sign in again.

## Tests

```
npm test
```

runs every unit and integration test (they use the sample files and never call Claude). `npm run check:done` runs them too, along with the hand-in checks.
