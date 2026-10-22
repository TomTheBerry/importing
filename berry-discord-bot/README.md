# BerryHost Discord ticket bot

Support tickets in Discord, kept in sync with BerryPanel.

- People press **Open a ticket** in Discord, pick a topic and fill in a short form. They get a private
  channel (`#ticket-0042`) that only they and staff can see. The ticket also appears on the Panel.
- Tickets opened on the Panel get a Discord channel too. The customer can see it if their Discord is
  linked to their account. Replies flow both ways, including files.
- Staff are pinged about every new ticket. Customers are never pinged.
- Everything is done with buttons (no slash commands), on the pinned card at the top of each ticket.
- Channels are named after the topic, customer and number, e.g. `#billing-payments-alex-0042`, and
  renamed if staff change the topic.
- **Roles:** people who link Discord to their Panel account can get a role (`DISCORD_LINKED_ROLE_ID` in
  the Panel `.env`), plus a role for each plan they have an active service on (set the "Discord role
  ID" on the plan in Admin → Billing). Roles are removed when a service ends or they unlink. The bot
  only ever touches these roles.
- Replies written on the Panel appear in Discord with the person's Panel name and profile picture.
  Staff show as `name • Role`. Staff who reply in Discord without a linked Panel account show on the
  Panel as `Name (Staff)`.
- People without a Panel account (or who haven't linked Discord) can still open tickets from Discord,
  for example if they can't sign up. These go in a separate **no-account** category
  (`#no-account-0042`). When staff link the ticket to an account on the Panel, the channel moves to
  the normal tickets category.
- Internal staff notes stay on the Panel and never reach Discord.
- Closing a ticket (on either side) deletes its Discord channel after 10 seconds. The full
  conversation stays on the Panel, and customers can reopen it there.

No npm packages are needed: the bot only uses what comes with Node.js 22.

## 1. Create the Discord bot

1. Go to <https://discord.com/developers/applications> → **New Application** → name it, e.g. *BerryHost Support*.
2. **Bot** page:
   - **Reset Token** and copy it. This is `DISCORD_TOKEN`. Never share it; anyone with it controls the bot.
   - Turn **on** *MESSAGE CONTENT INTENT* (needed to read replies in ticket channels).
   - If you use roles for linked accounts or plans, also turn **on** *SERVER MEMBERS INTENT*, so
     people get their roles the moment they join the server.
   - Turn **off** *Public Bot*, so only you can add it to servers.
3. Invite it to your server. Replace `APP_ID` with the *Application ID* from the **General Information** page:

   ```
   https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot&permissions=2952916048
   ```

   That gives it: View Channels, Send Messages, Embed Links, Attach Files, Read Message History,
   Add Reactions, Manage Channels, Manage Roles (only for ticket channel permissions), Manage
   Webhooks and Manage Messages. It does **not** ask for Administrator.

4. In your Discord server:
   - Create a category for tickets, e.g. **🎫 Tickets**. Make it private: deny *View Channel* for
     @everyone. The bot sets permissions on each ticket channel itself.
   - Make sure the bot's role can see that category (give the bot's role *View Channel*, *Manage
     Channels* and *Manage Roles* on it).
   - Pick your staff roles (e.g. Support, Moderator, Management). Everyone with one of these roles sees
     every ticket and counts as staff.
   - Optional: a second private category, e.g. **no-account-tickets**, for people without a Panel account.
   - A `#support` channel where the **Open a ticket** button lives (the bot posts it itself).

Turn on Developer Mode (User Settings → Advanced) so you can right-click → **Copy ID** on servers,
categories, channels and roles.

## 2. Connect the Panel

In the Panel's `.env` (not this bot's):

```
DISCORD_BOT_SECRET=<a long random value>
# Optional, but recommended: only accept the bot from your node's IP.
DISCORD_BOT_ALLOWED_IPS=
```

Make the secret with `php -r "echo bin2hex(random_bytes(32));"`, then run `php artisan config:clear`.

So 8 MB attachments can be uploaded, PHP on the Panel needs `upload_max_filesize = 10M` and
`post_max_size = 50M` (in `/etc/php/8.3/fpm/php.ini`, then restart php8.3-fpm).

For staff to show with their Panel name and role in Discord, and to use **Claim**, they link their
Discord on the Panel under **Account → Connections**. Customers can do the same, so their tickets show
up in Discord for them.

## 3. Run it on Pterodactyl

1. Create a server for the bot using a **Node.js** egg (the generic Node.js egg works), with the
   Docker image set to **Node.js 22** (e.g. `ghcr.io/parkervcp/yolks:nodejs_22`).
   - 256 MB RAM, 25–50% CPU and 512 MB disk is plenty. It needs one allocation (any port); the bot
     doesn't listen on it.
   - Startup file / `MAIN_FILE`: `src/index.js` (or startup command `node src/index.js`).
2. Upload everything in this folder to the server (File Manager or SFTP), keeping the `src` folder.
   You don't need to upload `test/`.
3. Copy `.env.example` to `.env` and fill it in:

   | Setting | What to put |
   | --- | --- |
   | `DISCORD_TOKEN` | The bot token from step 1 |
   | `GUILD_ID` | Your Discord server's ID |
   | `TICKET_CATEGORY_ID` | The tickets category's ID |
   | `NO_ACCOUNT_CATEGORY_ID` | Optional category for people with no Panel account |
   | `STAFF_ROLE_IDS` | Staff role IDs, comma separated |
   | `SUPPORT_PING_ROLE_ID` | Role to ping on new tickets (empty = all staff roles) |
   | `SUPPORT_CHANNEL_ID` | Channel for the **Open a ticket** button |
   | `PANEL_URL` | `https://panel.theberryhost.com` |
   | `BOT_SECRET` | The same value as `DISCORD_BOT_SECRET` on the Panel |

4. Start the server. The console tells you if anything is missing or wrong, then shows:

   ```
   Connected to the Panel (https://panel.theberryhost.com).
   Logged in to Discord as BerryHost Support.
   Posted the "Open a ticket" message in #…
   ```

The bot keeps a small `data/state.json` file (which message is the support panel, which message is
the top of each ticket). It's safe to delete; the bot rebuilds what it needs.

## Roles for linked accounts and plans

1. Create the roles in Discord (e.g. **Linked**, **Premium**). Drag the bot's own role **above** them
   in Server Settings → Roles, or Discord won't let it give them out.
2. Panel `.env`: `DISCORD_LINKED_ROLE_ID=<role id>` for everyone who links Discord (optional).
3. Admin → Billing → a tier or plan → **Discord role ID** for people with an active service on it.
4. Restart the bot once after turning roles on, so it starts listening for people joining.

Changes apply within a few seconds. Everyone is also re-checked daily at 04:20 (or run
`php artisan p:discord:sync-roles` on the Panel). Someone who isn't in the Discord server yet gets
their roles when they join.

## Buttons

There are no slash commands. Everything is on buttons:

| Button | Where | Who | What it does |
| --- | --- | --- | --- |
| **Open a ticket** | `#support` | Anyone | Pick a topic, fill in the form, get a private channel |
| **Claim** / **Take over** | Pinned card in each ticket | Staff with a linked Panel account | Marks you as handling the ticket |
| **Close** | Pinned card in each ticket | The customer or staff | Asks to confirm, then closes the ticket |

## Good to know

- Editing or deleting a message in Discord doesn't change it on the Panel (the Panel keeps the
  original). Reactions aren't synced.
- Files: images, text/log files, configs, PDFs and ZIPs up to 8 MB, 5 per message. Other files stay in
  Discord only, and the bot says so.
- Don't delete ticket channels by hand: close the ticket instead, so the Panel knows.
- If the bot is offline, nothing is lost. The Panel queues everything and the bot catches up when it
  starts again (jobs older than 3 days are dropped).
- Admin → Tickets on the Panel shows whether the bot is online.

## Troubleshooting

| Console says | Fix |
| --- | --- |
| `Discord rejected the bot token` | Reset the token and update `DISCORD_TOKEN` |
| `Turn on "MESSAGE CONTENT INTENT"` | Developer Portal → Bot → turn it on, then restart |
| `The Panel rejected BOT_SECRET` | `BOT_SECRET` must match `DISCORD_BOT_SECRET` on the Panel |
| `The Panel refused this IP` | Add the node's IP to `DISCORD_BOT_ALLOWED_IPS`, or leave it empty |
| `The Panel bot API is turned off` | Set `DISCORD_BOT_SECRET` on the Panel and run `php artisan config:clear` |
| `Missing Permissions` | Give the bot's role Manage Channels, Manage Roles and Manage Webhooks on the tickets category |
| `move the bot's role above the account/plan roles` | Server Settings → Roles: drag the bot's role above the roles it gives out |

## Tests

`npm test` (or `node --test test/*.test.js`) runs the bot's tests. No Discord account is needed for
them.

---

© 2026 Berry Technologies Ltd, trading as TheBerryHost. Confidential.
