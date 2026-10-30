# Kettle & Stone waitlist shortlist

When a client cancels late, this tool shows the front desk up to 3 waitlist people who fit, or "nobody". It never contacts clients.

## Set it up (once, 30 minutes)

Keep keys (long passwords) private. Never email them.

1. **GitHub** (stores the code): sign in and press **Fork**.
2. **Supabase** (stores records and logins):
   - Create a project in **Canada (Central)**.
   - In **SQL Editor**, paste `supabase/schema.sql` and press **Run**.
   - Copy the **Project URL** (project home page), then the **Publishable key** and **Secret key** (**Project Settings › API Keys**).
   - Under **Authentication › Users**, add each staff member.
3. **Anthropic** (reads the notes): at platform.claude.com, create an API key. Set a $10 monthly limit.
4. **Vercel** (puts it online): sign in with GitHub and import your copy. Add these **Environment Variables** and press **Deploy**:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Secret key |
   | `ANTHROPIC_API_KEY` | Claude API key |

Cost: about $46–50 a month.

## Test it

1. Open your Vercel link and sign in.
2. Download the waitlist, late-openings and appointments files from `data/sample`.
3. In **Waitlist (admin)**, choose them, set the run date to **Oct 21, 2026**, and press **Import and analyse**. Expect 60 lines read, 30 people ready, 20 stale, 10 repeats.
4. In **Search**, pick **All openings from a file** and press **Search all openings**.
5. Check: **O39** shows Shawn Duguay, Luc Bernard, Lise Gautreau. **O40** shows nobody.

## Daily use

1. Load new files in **Waitlist (admin)**.
2. In **Search**, pick **One opening**, fill it in, and press **Search waitlist**.
3. Call the first name. Once booked in Kneadly, press **Booked**. **Undo** fixes mistakes.

## Problems

- **Deploy failed:** check the variable names, then **Redeploy**.
- **"Not read":** check the Claude key, then **Redeploy**.
- **File refused:** use it exactly as exported.

Use sample files only until Marc approves the privacy note.
