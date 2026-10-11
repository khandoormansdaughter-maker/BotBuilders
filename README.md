# BotBuilders

Minecraft bots that can inspect schematic files, plan builds, gather/check materials, and construct them from commander chat commands.

## Current status

The initial Node.js/Mineflayer scaffold is in place. It connects to a server, checks the sender of chat commands against a configured commander username, lists schematic files, selects a file, stores two coordinates, and supports a basic `say` command. **Actual schematic parsing, material accounting, and block placement are not implemented yet.** The bot deliberately refuses to claim a build is ready until those systems exist.

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

Put supported files in `Input/`. The starter can list `.schem`, `.schematic`, and `.litematic` filenames, but this is **not** the same as being able to parse or build them. Litematica's `.litematic` format needs a compatible parser or conversion step; support will be added before enabling real builds.

## Chat commands

Commands are accepted only when the chat event's sender username exactly matches `COMMANDER_USERNAME`.

- `Builders help` — show command list
- `Builders schem list` — list files in `Input/`
- `Builders schem set <filename>` — select an existing file
- `Builders coords set1 <x y z>` — set first corner
- `Builders coords set2 <x y z>` — set second corner
- `Builders material list` — planned; currently reports that material accounting is not implemented
- `Builders build schem` — planned; currently disabled until validation and placement are implemented
- `Builders say <message>` — send a message to public chat

## Build roadmap

1. **Schematic adapter:** parse dimensions, palette, block states, and required counts; validate Litematica support or document a reliable conversion workflow.
2. **Placement validation:** verify both corners, orientation, world height, bounding-box dimensions, and loaded/accessible space before moving blocks.
3. **Inventory and supply planning:** count inventory, bundles, and shulker contents; account for tool requirements and spare traversal blocks; report shortages before starting.
4. **Build executor:** place blocks in a safe order, pathfind around obstacles, track progress, and recover from interruptions without silently duplicating work.
5. **Supply staging:** stage clearly labeled shulkers only after the plan is validated; report coordinates and contents, and avoid overwriting existing blocks without explicit approval.
6. **Chat hardening:** support server-specific disguised/system messages only through tested parsers; ignore messages whose sender cannot be authenticated, rate-limit commands, and avoid treating arbitrary chat text as authority.
7. **Tests and CI:** unit-test parsing, inventory arithmetic, coordinate bounds, command authorization, and dry-run plans before allowing real placement.

## Safety and reliability notes

- Test on a private or disposable world first. Building can alter or replace world blocks.
- The bot should default to a dry-run plan until schematic parsing, bounds checks, and material checks pass.
- Never trust a username-looking string inside a message as the sender identity. Disguised chat formats must be explicitly parsed and tested for the target server.
- Do not store credentials in source files or logs.
