// voice-test.mjs - Run on the VM: node voice-test.mjs <BOT_TOKEN> <VOICE_CHANNEL_ID>
import { Client, GatewayIntentBits } from "discord.js";
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from "@discordjs/voice";

const token = process.argv[2];
const channelId = process.argv[3];
if (!token || !channelId) {
  console.error("Usage: node voice-test.mjs <BOT_TOKEN> <VOICE_CHANNEL_ID>");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once("ready", async () => {
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
  connection.on("stateChange", (o, n) => console.log("State:", o.status, "->", n.status));
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    console.log("Voice READY – connection works on this host.");
  } catch (e) {
    console.error("Voice failed:", e.message);
  }
  connection.destroy();
  client.destroy();
  process.exit(0);
});

client.login(token);
