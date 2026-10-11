# BotBuilders

Minecraft bots that inspect schematic files, estimate material requirements, plan builds, and eventually construct them from commander chat commands.

## Current status

The Node.js/Mineflayer scaffold connects to a server, authorizes commands by the chat sender username, lists/selects schematic files, stores two coordinates, and supports a basic `say` command. **Litematica parsing and a first-pass material report are now implemented. Actual block placement, live inventory comparison, and supply staging are not implemented.** The bot deliberately refuses to claim a build is ready until those systems exist.

## Requirements

- Node.js 20+
- A Minecraft server the operator is authorized to use, reachable from the GitHub Actions runner
- GitHub Actions enabled for the repository

## Configure GitHub Actions

In repository **Settings → Secrets and variables → Actions**, add:

- `MC_USERNAME`: bot's in-game username
- `COMMANDER_USERNAME`: exact in-game username allowed to control the bot
- `MC_AUTH` (optional): Mineflayer authentication mode; defaults to `offline` for offline-mode servers

Run **Actions → Run BotBuilders → Run workflow**, then enter the server host, port, and optionally the Minecraft version. Do not put passwords or tokens in workflow inputs, commit them to the repository, or send them in chat. Offline-mode servers typically do not use a Minecraft account password; servers with an authentication plugin may require a separate, server-specific login flow.

GitHub-hosted runners are temporary and their outbound network access may not work with every server. The workflow has a six-hour job limit and stops when the job ends.

## Schematic files

Put files in `Input/`. The bot can list `.schem`, `.schematic`, and `.litematic` files, but **material counting currently supports only `.litematic`**. Sponge schematic formats are listed but not parsed yet.

## Chat commands

Commands are accepted only when the chat event's sender username exactly matches `COMMANDER_USERNAME`.

- `Builders help` — show command list
- `Builders schem list` — list files in `Input/`
- `Builders schem set <filename>` — select an existing file (include the extension)
- `Builders coords set1 <x y z>` — set first corner
- `Builders coords set2 <x y z>` — set second corner
- `Builders material list` — for a selected `.litematic`, count non-air blocks by type and estimate stacks/shulker boxes
- `Builders build schem` — disabled until placement validation, inventory checks, and safe execution are implemented
- `Builders say <message>` — send a message to public chat

The shulker estimate is approximate: it assumes 64-item stacks and 27 stacks per box, and does not yet account for item-specific stack limits, inventory contents, tools, or spare blocks.

## Build roadmap

1. **Test the parser:** validate Litematica NBT parsing and palette decoding against known sample files, including empty blocks and multiple regions.
2. **Schematic adapter:** support Sponge `.schem` files and expose dimensions/origin/orientation.
3. **Placement validation:** verify both corners, orientation, world height, bounding-box dimensions, and loaded/accessibility before moving blocks.
4. **Inventory and supply planning:** count inventory and shulker contents; account for tool requirements and spare traversal blocks; report shortages before starting.
5. **Build executor:** place blocks in a safe order, pathfind around obstacles, track progress, and recover from interruptions without silently duplicating work.
6. **Supply staging:** stage clearly labeled shulkers only after the plan is validated; report coordinates and contents, and avoid overwriting existing blocks without explicit approval.
7. **Chat hardening and tests:** support server-specific system messages only through tested parsers; ignore messages whose sender cannot be authenticated; test parsing, arithmetic, bounds, authorization, and dry-run plans before allowing real placement.

## Safety and reliability notes

- Test on a private or disposable world first. Building can alter or replace world blocks.
- Keep real placement disabled until parsing, bounds checks, and material checks pass.
- Never trust a username-looking string inside a message as the sender identity. Disguised chat formats must be explicitly parsed and tested for the target server.
- Do not store credentials in source files or logs.
