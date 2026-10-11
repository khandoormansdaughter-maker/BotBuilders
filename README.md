# BotBuilders

Minecraft bots that inspect schematic files, compare materials across a team of bots, plan builds, and eventually construct them from commander chat commands.

## Current status

The Node.js/Mineflayer scaffold connects to a server, authorizes commands by the chat sender username, lists/selects schematic files, stores two coordinates, and supports a basic `say` command. Litematica parsing and first-pass material counting are implemented. **Team inventory reports now aggregate the player inventories of configured bots. Actual block placement, shulker/chest scanning, and supply staging are not implemented.**

## Requirements and configuration

- Node.js 20+
- A Minecraft server the operator is authorized to use, reachable from the GitHub Actions runner
- GitHub Actions enabled for the repository

In **Settings → Secrets and variables → Actions**, configure:

- `MC_USERNAME`: default bot username, used if the workflow input is blank
- `COMMANDER_USERNAME`: exact in-game username allowed to issue commands
- `BOT_COORDINATOR_USERNAME`: username of the one bot instance that coordinates inventory queries
- `BOT_GROUP`: comma-separated Minecraft usernames for the team, e.g. `BuilderOne,BuilderTwo,BuilderThree`
- `MC_AUTH` (optional): Mineflayer authentication mode; defaults to `offline`
- `BOT_CREDENTIALS` (optional): up to five lines, one per bot, formatted `botname/botpassword`; each bot uses the password matching its current `MC_USERNAME`/`bot_username`

Run **Actions → Run BotBuilders → Run workflow** once per bot, using the same server and a distinct `bot_username` for each instance. Every bot must use the same `BOT_COORDINATOR_USERNAME`, `BOT_GROUP`, and `COMMANDER_USERNAME`. Keep the coordinator's username in `BOT_GROUP`. Inventory commands should be sent to the coordinator bot.

Add `BOT_CREDENTIALS` under repository **Settings → Secrets and variables → Actions → New repository secret**. Put one pair on each line, for example `BuilderOne/replace-with-password` and `BuilderTwo/replace-with-password` (use your real usernames and passwords; these examples are placeholders). Up to five lines are supported. The bot responds to the exact register/login prompts when they arrive as system messages, using only the password matching its own username. Never commit passwords or put them in workflow inputs. Offline-mode servers typically use username-only login; if the server sends prompts as ordinary player chat rather than system messages, the bot intentionally will not react to avoid leaking credentials.

GitHub-hosted runners are temporary and their outbound network access may not work with every server. Each workflow run has a six-hour job limit and stops when the job ends.

## Schematic files

Put files in `Input/`. The bot lists `.schem`, `.schematic`, and `.litematic` files, but material counting currently supports only `.litematic`. Sponge schematic formats are listed but not parsed yet.

## Chat commands

Commands are accepted only when the chat event's sender username exactly matches `COMMANDER_USERNAME`.

- `Builders help` — show command list
- `Builders schem list` — list files in `Input/`
- `Builders schem set <filename>` — select an existing file (include the extension)
- `Builders coords set1 <x y z>` — set first corner
- `Builders coords set2 <x y z>` — set second corner
- `Builders holder BuilderOne BuilderTwo` — ask the named bots for their current player inventories and print per-bot and combined totals
- `Builders material list` — compare the selected Litematica's required block counts with combined inventories for `BOT_GROUP`
- `Builders build schem` — disabled until placement validation and safe execution are implemented
- `Builders say <message>` — send a message to public chat

Inventory requests use chat messages between bot instances. All instances need to be online, on the same server, and configured with the same coordinator username. If a bot does not reply, the coordinator reports it as missing. **This chat protocol is not cryptographically authenticated**; use it only on a server where usernames and chat senders are trustworthy, and do not treat its totals as authoritative on an untrusted/offline-mode server.

The current comparison only counts each bot's carried player inventory. It does not inspect other players, shulker boxes, ender chests, or world chests. It also does not yet fully handle item variants, item-specific stack limits, tools, or spare blocks. Material reports are advisory and do not enable building.

## Build roadmap

1. Test Litematica NBT parsing and palette decoding against known files, including empty blocks and multiple regions.
2. Support Sponge `.schem` files and expose dimensions/origin/orientation.
3. Validate both corners, orientation, world height, bounding-box dimensions, and loaded/accessibility before movement.
4. Improve inventory accounting for item variants, stack limits, tools, and shulker contents; report shortages before starting.
5. Implement a dry-run build plan, then a guarded executor that tracks progress and recovers from interruptions.
6. Stage clearly labeled shulkers only after the plan is validated; avoid overwriting existing blocks without explicit approval.
7. Add tested server-specific system-chat parsers and automated tests for parsing, inventory arithmetic, bounds, and command authorization.

## Safety and reliability notes

- Test on a private or disposable world first. Building can alter or replace world blocks.
- Keep real placement disabled until parsing, bounds checks, and material checks pass.
- Never trust a username-looking string inside a message as the sender identity. Disguised chat formats must be explicitly parsed and tested for the target server.
- Do not store credentials in source files or logs.
