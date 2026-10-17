# Demo video plan: one brain per business (about 4 minutes)

The submission's required video (#14), recorded tonight, 17 October, after the last builds land. Everything runs live on
https://13-232-139-42.sslip.io. Nothing is pre-played; if something outside the product fails, a replay is used and labelled on
screen.

## Before you press record (10 minutes)

1. **Browser:** Chrome, 1280 × 800 window, light theme, zoom 100%. Notifications and other tabs off.
2. **Sign in** at the live site as yourself (you@example.com), so Aamdani shows in full.
3. **Open these four tabs, in order:**
   - Tab 1: the website, https://ankit-vohra.github.io/allevia-site/
   - Tab 2: Blue Tokai's Brain, https://13-232-139-42.sslip.io/brain?tenant=bluetokai
   - Tab 3: Aamdani's Home, https://13-232-139-42.sslip.io/?tenant=aamdani
   - Tab 4: Aamdani's Your tools, https://13-232-139-42.sslip.io/connections?tenant=aamdani
4. **Recorder:** QuickTime (File → New Screen Recording), microphone on. Or record the screen silently and add voice afterwards.
5. **Prepared for you** (Claude does this before you start): each question below asked once already, so a fallback thread
   exists; the demo cards tidied; the server checked.

## The script

### 0:00 The problem, 20 s (tab 1, the website's hero)

> "A founder's business lives in their head, their inbox and a dozen tools. Allevia turns it into one company brain, a
> FalkorDB graph for each business, with an AI team that works from it. Nothing goes out without your OK."

Scroll once to show the office, then switch tabs.

### 0:20 Blue Tokai Coffee: what it can do, 90 s (tab 2)

Blue Tokai is a known coffee brand. Its website, reviews, Instagram and rivals' ads are real public data; orders and payments
are sample numbers, labelled as such.

1. **The map.**
   - Point at "2,123 things · 5,938 links". Tap **Watch it grow** for about 5 s.
   - Tap **Third Wave Coffee**. Say: "Every fact keeps where it came from and when."
2. **Chat → Your team.**
   - Tap the mic and say, or type: *Why did online orders drop this week, and what should we do?*
   - While the team works (about 75 s), point at the office: The Chief hands the question to Data Detective, Firefighter,
     Bug Hunter and the rest.
   - Read the first lines: UPI failures went from 12% to 41% after checkout release 4.12, while card orders held.
3. **How we got this.**
   - The lit path runs: online store → a customer's email → UPI payments → the error → release 4.12.
   - Say: "Those are real links in FalkorDB, not a guess. And the graph read 8 times fewer tokens than pasting the documents
     in."
4. **Needs your OK.** The fix and the customer message are waiting. Tap **Look**, then **OK**. "Nothing goes out
   without me."

### 1:50 Aamdani, our own startup: real data, 60 s (tabs 3 and 4)

> "We built Allevia from what we learned running Aamdani."

1. **Your tools** (tab 4): Gmail, Calendar, Analytics, Search Console, Instagram and Higgsfield, all connected for real.
2. **Home** (tab 3):
   - The living brain.
   - "What your team did this week".
   - Ask: *How is our website doing this month, and where do our visitors come from?* Read: 289 visits, mostly direct and
     from AI assistants.
3. **Remember this meeting:** paste the short sample call notes and say "remember this meeting". Decisions and tasks land
   in the brain, with the follow-up email waiting for OK.
4. **Studio:** "Make a Dussehra poster with our logo". A real picture comes back on your Higgsfield credits; show it waiting
   for OK. Use this only if tonight's Higgsfield build is live; otherwise skip it.

### 2:50 Close, 30 s

Show **Plan and credits**: monthly or yearly, 30% off, credits for every service.

> "One brain for each business, an AI team that works from it, and you stay in charge. Sign up for 100 free credits at the
> link below; the code is public."

End on the live link and https://github.com/Ankit-Vohra/allevia-company-brain.

## After recording

- **Trim:** keep it under 4:30.
- **Upload:** to YouTube (unlisted), or Loom.
- **Submit:** paste the link in the submission form. The other four fields are in `docs/submission.md`.

## If something goes wrong on camera

- **An answer is slow:** keep talking over the office animation. A question can take up to 90 s.
- **An answer fails:** open the same question's earlier thread in the Chat list (asked beforehand) and say "here's the one
  from earlier".
- **The poster picture fails:** skip the Studio step; the rest stands on its own.
