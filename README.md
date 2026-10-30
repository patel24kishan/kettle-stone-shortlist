# Kettle & Stone waitlist shortlist

When a client cancels late, this tool shows the desk up to 3 waitlist people who fit, or "nobody".

## Set it up (once, 30 minutes)

Keep the keys (long passwords) in a private note. Never email them.

1. **GitHub:** press **Fork** on this page.
2. **Supabase:** create a project in **Canada (Central)**. In **SQL Editor**, run `supabase/schema.sql`. Copy the Project URL, anon key and service role key. Add a login per staff member under **Authentication › Users**.
3. **Anthropic:** at console.anthropic.com, create a key. Set a $10 monthly limit.
4. **Vercel:** sign in with GitHub and import the tool. Add these **Environment Variables**, then press **Deploy**:
   - `NEXT_PUBLIC_SUPABASE_URL`: Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: anon key
   - `SUPABASE_SERVICE_ROLE_KEY`: service role key
   - `ANTHROPIC_API_KEY`: Claude key

Cost: about $46–50 a month.

## Test it

1. Open your Vercel link and sign in.
2. In **Waitlist (admin)**, load the three files from `data/sample`, set the date to Oct 21, 2026, and press **Import and analyse**.
3. In **Search**, press **Search all openings**.
4. **O39** should show Shawn Duguay, Luc Bernard, Lise Gautreau. **O40** should show nobody.

## Daily use

Search an opening, call the first name, then press **Booked**. **Undo** fixes mistakes.

## Problems

- **Deploy failed:** check the variable names, then **Redeploy**.
- **"Not read":** check the Claude key.

Sample files only until Marc approves the privacy note.
