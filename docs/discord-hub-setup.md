# Discord hub: what the founder sets up

Customers join ONE Discord server, the hub. One shared Allevia bot serves all of them. When a business is onboarded,
Allevia sets up its area on the hub by itself and gives the owner a link to join. You do the steps on this page once.
After that nothing is manual.

Nothing on this page needs code. Real ids and the bot's token go only in `~/.config/allevia/allevia.env`, never in the
repository.

## What each customer gets

Each company is one private category named after the business (for example "AVS Atelier"), with the same channels in
the same order every time:

| Channel | What it is for |
|---|---|
| `#your-team` | Ask the team anything, any time, in your own words. Each question opens a thread. The answer is the same one the web app gives. |
| `#studio` | Drop photos and videos. The team turns a photo into post options for your OK. |
| `#approvals` | Things waiting for the owner's OK, with Approve and Reject buttons. Read-only otherwise. |
| `#todays-note` | The daily note. Read-only. |
| `#support` | People only. The team of assistants never answers it. |

Behind it: a role `customer-<business>` that has no powers of its own and only unlocks that area, a welcome message in
plain words, and a join link (one person, one use, 7 days). Only that role, the Allevia staff role and the bot can see
the area. Each channel's topic says in one line what it is for.

Staff-only channels live in one **Allevia Staff** category at the top of the server. Today that is `#support-inbox`:
everything a customer writes in `#support` is copied there, with the business name and a link to the message. Allevia
creates the category and the inbox itself, the first time it sets a business up.

## One conversation, two doors

The owner can talk to the team in `#your-team` or in the web app. It is one conversation:

- A question asked in `#your-team` goes through the same path as the web app. A Discord thread and a web thread are the
  same conversation in the graph, and each turn records which door it came through (web or Discord).
- A thread started on Discord shows in the web app's history and can be continued there.
- A thread started in the web app can be carried on in Discord: type `/continue` in `#your-team`, tap the conversation,
  and a Discord thread opens with a recap. Replies there continue the same conversation.
- While the team works, the thread shows one message that is edited as each person starts and finishes a step.

## Photos and videos in `#studio`

The owner drops photos in `#studio` (or attaches one in `#your-team`). In a new thread the team does the Studio flow:
Tara looks at the photo, makes two options, Nisha checks the building is unchanged and picks "our pick", Dev writes the
caption. Each option comes back as an image with the caption and **Approve** and **Change** buttons.

- **Option A** is a free local clean-up. **Option B** is an AI edit made by the AI editor (Higgsfield), priced before it is
  made and shown in Studio credits ("about 2 Studio credits"). If the editor is not signed in, the balance is low or a
  daily or per-edit cap is reached, the owner still gets option A and one plain sentence says why.
- **Approve** saves the option as a draft post (nothing is published) and records it, with where it came from, in the
  graph. It is the same decision as approving on the web.
- A text reply under the options changes things. Light and colour ("make it warmer", "a bit darker") are free and local.
  Anything else ("make it festive", "change the background", "remove the pole", "make this into an ad saying Free site
  visit this week") goes to the AI editor with the business's brand rules, shows its price, and comes back as a new option
  that Nisha checks with the owner's request allowed. If Nisha holds an AI edit back, a **Try again** button (with its
  price) makes one more try with a tighter lock. "Make a short reel" offers a 5 second 9:16 clip with a **Make the clip**
  button and its price (about 7.5 Studio credits); it is silent, has no text, and is cropped to the middle of the photo.
- People in a photo are kept as they are. The one setting is "Blur people's faces in my content" (off by default): say
  "blur faces from now on" or "stop blurring faces" in `#studio`, or change it on the web Studio page. A photo that seems
  to include a child gets the free clean-up only (no AI edit, no clip), with faces blurred in what is kept, and one plain
  sentence says so. No identity is stored, and EXIF (including location) is removed from what is kept.
- In `#your-team`, "from now on always answer in English" (or Hindi, Hinglish, "in the language I write in") sets the
  language of the team's answers; by default the answer follows the language the owner wrote in.
- **Videos** (MP4, MOV, WebM, up to 25 MB) are kept as they are. If `ffmpeg` is installed on the server, the location and
  device details are removed from the file and Tara looks at the first frame. If it is not, the video is kept untouched and
  the owner is told in plain words that the team cannot look inside videos on this server yet. Nothing edits video today.
  `brew install ffmpeg` (or your package manager) switches the first-frame look on; `discord-hub status` says which.

What is accepted: at most 4 files per message; photos JPEG, PNG or WebP up to 10 MB; only files uploaded to Discord itself
(`cdn.discordapp.com` or `media.discordapp.net`, over https). Anything else is refused with a plain sentence. One Studio run
happens at a time across all customers; the next one waits and is told so. Photos use the local recorded engine and the
subscription's vision; no paid Higgsfield call is made from Discord.

## Step 1. The staff role

1. In the hub: Server Settings, Roles, Create Role. Name it `Allevia staff`.
2. Leave every permission off. The role only decides who can see the customer areas and `#support-inbox`.
3. Give it to yourself and to anyone on the Allevia team (Server Settings, Members).
4. Turn on Developer Mode (User Settings, Advanced). Then right-click the role (Server Settings, Roles) and choose
   Copy Role ID. This is `DISCORD_STAFF_ROLE_ID`.
5. Right-click the server's name in the left bar and choose Copy Server ID. This is `DISCORD_HUB_GUILD_ID`.

## Step 2. The bot's switches (Discord Developer Portal)

Open the bot's page at discord.com/developers/applications, then Bot, then Privileged Gateway Intents:

- **Server Members Intent: ON.** Required. It is how the bot hears that someone joined, so it can give them their role.
  Without it nobody gets access.
- **Message Content Intent: ON.** Lets the team read what a customer writes in `#your-team`. (The demo bot already needs it.)

If the bot's token was ever pasted anywhere it should not be, press Reset Token on the same page and put the new one
in `DISCORD_BOT_TOKEN` (step 4). Never paste it into chat, a document or the repository.

## Step 3. Add the bot to the hub

The bot needs exactly these permissions:

| Permission | Why |
|---|---|
| View Channels | See the customer areas it manages. |
| Send Messages | Post answers, cards, notes and the welcome message. |
| Send Messages in Threads | Answer inside a question's thread. |
| Create Public Threads | Open a thread for each question. |
| Read Message History | Follow a thread and read a card it posted. |
| Embed Links | Show the link to the path behind an answer. |
| Attach Files | Discord only lets the bot give customers a permission it holds itself; customers may attach a screenshot in `#support`. |
| Manage Channels | Make each customer's category and channels. |
| Manage Roles | Make each customer's role and give it to the person who joins. |
| Create Instant Invite | Make the one-use join link. |

It does **not** need Administrator, Manage Server, Manage Messages, Kick or Ban. Do not give it those.

The easy way: run `npm run cli -- discord-hub status`. If the bot is not in the hub yet, it prints a link that asks for
exactly the permissions above. Open the link, pick the hub server, and press Authorize. (The link needs
`DISCORD_APPLICATION_ID` from step 4.)

Then one Discord detail that matters: in Server Settings, Roles, drag the bot's role **above** the roles it hands out
(every `customer-...` role). Discord only lets a bot give roles that sit below its own. New customer roles are made at
the bottom, so once the bot's role is above `@everyone` and the staff role you rarely touch this again.

Recommended hub settings: switch off "Create Invite" for `@everyone` (Server Settings, Roles, Default permissions), so
nobody but the bot can make links, and keep the hub out of Server Discovery. A person with no role sees no customer
area at all.

## Step 4. The environment file

Add these lines to `~/.config/allevia/allevia.env`. The file lives outside the repository. Use the real values; never
commit them.

```
# the one shared bot (the same values the demo bot uses)
DISCORD_BOT_TOKEN=<the bot's token>
DISCORD_APPLICATION_ID=<the bot's application id>

# the customer hub
DISCORD_HUB_GUILD_ID=<the hub server's id>
DISCORD_STAFF_ROLE_ID=<the Allevia staff role's id>
```

`DISCORD_GUILD_ID` and `DISCORD_CHANNEL_ID` are the old single-channel demo server. Leave them as they are.

Setting `DISCORD_HUB_GUILD_ID` is what switches on hub mode:

- `npm run cli -- serve` sets a business up on the hub right after onboarding, and shows the owner "Join your team on
  Discord". If Discord is slow or down, onboarding still finishes, the owner sees "We'll send your Discord link
  shortly", and the server keeps retrying in the background.
- `npm run cli -- discord` runs the shared bot for every customer (conversations, `#studio`, approval cards, the daily note, support copies). Add `--demo` to run the old demo bot instead.
  Leave `DISCORD_HUB_GUILD_ID` unset and nothing changes from before.

## Step 5. Check it

```
npm run cli -- discord-hub status
```

This only reads from Discord. It creates and changes nothing. It prints a PASS / FAIL list in plain words: the settings
are present, the bot's token is accepted, the bot is in the hub, it has every permission, both switches are on, the
staff role exists, the bot's role sits above the customer roles, there is room left on the server, and whether ffmpeg is
installed (optional, never a FAIL). Each FAIL says
what to do. It exits with an error while anything fails.

## Staff commands

```
npm run cli -- discord-hub status
npm run cli -- discord-hub list                    # every company with its channels, checked against Discord (read-only)
npm run cli -- discord-hub provision <business>    # set the business up, or repair it; safe to run again
npm run cli -- discord-hub reinvite <business>     # a fresh one-use link; the old one stops working
```

`provision` also puts the channels back in order, moves `#support-inbox` into Allevia Staff, and adds `#studio` to a company
that was set up before it existed. `provision` never builds a second copy: it finds what is already there, creates only what is missing and puts the
permissions back to what they should be. That also means a permission someone adds by hand to a customer channel is
removed by the next run, on purpose. Use the roles.

Use `reinvite` for a lost or expired link, or to bring a second person from the same business. The owner can also press
"Get a new link" on Home.

## Good to know

- **Who can do what.** Only people holding a business's own role can ask its team, press Approve or Reject, or write in
  its `#support`. The staff role can read everything and answer in `#support`, but never asks a customer's team
  questions or decides a customer's cards.
- **Two businesses are walled off.** The bot works out which business a message belongs to from the channel it was
  posted in, through a list kept in the graph database. Nothing a customer types, and no channel name, ever picks a
  business. A channel the bot does not know is ignored, and so is any direct message.
- **Joining.** The bot tells which link a new member used by comparing the links before and after. If it cannot tell
  (two links used in the same moment, or a link used while the bot was off) the person gets no access, and
  `#support-inbox` says who to give the role to by hand (Server Settings, Members, add the `customer-...` role). Do not
  delete join links by hand: use `reinvite`, so Allevia knows what happened to them.
- **Size.** Discord allows 250 roles and 500 channels in one server. Each customer uses 1 role and 6 channels (the category
  and five channels), so one hub holds about 80 customers. `discord-hub status` warns before the limit.
- **Approval cards and the daily note** are posted into each customer's channels by the shared bot (checked every
  minute). A card decided on the web loses its buttons in Discord.
- **Dry run by default.** Approving a card on Discord does exactly what approving it on the web does: GitHub issues and
  Discord posts are only recorded unless `ALLEVIA_ACTIONS_LIVE=1`.
