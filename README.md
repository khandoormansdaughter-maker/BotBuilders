# BotBuilders
Ai created Bots for servers that load a litematica file and build it.

what this should do:
use a public minecraft bot creation library that will let us put litematica files in a Input/ folder in the repo, run it with a github action and it should let you pick a server ip (cracked), the bot username and password (it should detect in chat the commander username which we set as a github repo secret (it should detect disguised messages aswell and any custom text in a message so it dosnt mess it up) allow these commands in chat from the commander:


Builders schem set
Sets the builders schematics to the specified one.

Builders coords set1 
Sets the first coordinate for the builder

Builders coords set2
Sets the second coordinate for the build (the builders should check the size of the schematic and if there isnt enough space they should tell the user that)

Builders material list
List the materials for the selected schematic in chat (in shulker boxes, like if it needs 1728 pieces of sand (27 stacks) it says 1 shulker. etc etc) and it shouldnt mention any materials that they already have. also if they dont have tools they should ask for them (diamond tools or better)

Builders schem list
will list all schematic names in chat

Builders say message
makes builders say messages in chat

Builders build schem 
builds the schematic listed (checks if they have the materials in the inventory, in bundles or in shulkers if not tell the user and deny if yes place the shulkers in a nearby spot, list the shulkers coords and what they contain so if they run out of said material later on they can go get it) 

Builders help
list all commands they have


also make them parkour aware/ask for extra/spare blocks so if they need to reach something else they can (say dirt to build up. dirt being the extra block they should use)

improve this idea in ways you see fit etc etc
