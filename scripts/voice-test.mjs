#!/usr/bin/env node
/**
 * Minimal voice connection test (no OpenClaw).
 * Run on the same host where the bot runs to check if Discord voice UDP works.
 *
 *   node scripts/voice-test.mjs <BOT_TOKEN> <VOICE_CHANNEL_ID>
 *
 * If this fails with "Voice failed" / connecting→signalling, the problem is
 * the host network (NAT, firewall, routing), not the plugin.
 */
import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} from "@discordjs/voice";

const token = process.argv[2];
const channelId = process.argv[3];
if (!token || !channelId) {
  console.error("Usage: node scripts/voice-test.mjs <BOT_TOKEN> <VOICE_CHANNEL_ID>");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

function onReady() {
  (async () => {
    console.log("Bot ready:", client.user.tag);
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isVoiceBased()) {
      console.error("Not a voice channel");
      client.destroy();
      process.exit(1);
    }
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    connection.on("stateChange", (o, n) =>
      console.log("State:", o.status, "->", n.status),
    );
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      console.log("Voice READY – connection works on this host.");
    } catch (e) {
      console.error("Voice failed:", e.message);
    }
    connection.destroy();
    client.destroy();
    process.exit(0);
  })();
}

if (client.isReady()) {
  onReady();
} else {
  client.once("clientReady", onReady);
}
client.login(token);
