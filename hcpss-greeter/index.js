require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior } = require('@discordjs/voice');
const play = require('play-dl');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// Map of values to exactly match the Cloudflare Worker's generated role names
const ROLE_MAPPINGS = {
  'normal_operations': 'HCPSS Normal Operations',
  'schools_closed': 'HCPSS Schools Closed',
  'schools_and_offices_closed': 'HCPSS Schools and Offices Closed',
  'schools_open_2_hours_late': 'HCPSS Schools Open 2 Hours Late',
  'schools_close_3_hours_early': 'HCPSS Schools Close 3 Hours Early',
  'unknown_alert': 'HCPSS Other/Unknown Alert'
};

let currentVoiceConnection = null;
let currentVoiceChannel = null;

const musicPlayer = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Play,
  },
});
let musicQueue = [];
let isPlayingMusic = false;

async function playNextSong() {
  if (musicQueue.length === 0) {
    await loadPlaylist();
    if (musicQueue.length === 0) {
      isPlayingMusic = false;
      return;
    }
  }

  const track = musicQueue.shift();
  try {
    if (track.startsWith('http')) {
      let stream = await play.stream(track);
      let resource = createAudioResource(stream.stream, { inputType: stream.type });
      musicPlayer.play(resource);
      isPlayingMusic = true;
      console.log(`Now playing stream: ${track}`);
    } else {
      let searched = await play.search(track, { limit: 1 });
      if (searched && searched.length > 0) {
        let stream = await play.stream(searched[0].url);
        let resource = createAudioResource(stream.stream, { inputType: stream.type });
        musicPlayer.play(resource);
        isPlayingMusic = true;
        console.log(`Now playing: ${searched[0].title}`);
      } else {
        console.log(`Could not find ${track} on YouTube. Skipping...`);
        playNextSong();
      }
    }
  } catch (err) {
    console.error("Error playing song:", err);
    setTimeout(playNextSong, 2000);
  }
}

let currentPlaylistUrl = process.env.PLAYLIST_URL || 'https://open.spotify.com/playlist/1Njedyj01AnBWG2MbUtCEt?si=QYOsPmOeQ7qQrIybyUcIuQ&utm_source=copy-link&pi=PIAugKKQTS29_&pt=6b3c22efcf12ac162e4f59e71c26b2c8';

async function loadPlaylist() {
  const url = currentPlaylistUrl;
  try {
    if (play.is_expired()) {
        await play.refreshToken();
    }
    
    if (url.includes('spotify')) {
      let sp_data = await play.spotify(url);
      let tracks = await sp_data.all_tracks();
      musicQueue = tracks.map(t => `${t.name} ${t.artists.map(a => a.name).join(' ')}`);
    } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
      let yt_data = await play.playlist_info(url, { incomplete: true });
      let tracks = await yt_data.all_tracks();
      musicQueue = tracks.map(t => t.url);
    }
    console.log(`Loaded ${musicQueue.length} tracks into queue.`);
  } catch (err) {
    console.error("Error loading playlist. Falling back to Lofi Girl stream...", err.message);
    musicQueue = ["https://www.youtube.com/watch?v=jfKfPfyJRdk"];
  }
}

musicPlayer.on(AudioPlayerStatus.Idle, () => {
  isPlayingMusic = false;
  playNextSong();
});

const PROCESSED_FILE = path.join(__dirname, 'joinlogs_processed.json');

function loadProcessed() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading processed file', e);
  }
  return [];
}

function saveProcessed(arr) {
  try {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.error('Error saving processed file', e);
  }
}

async function processLegacyJoinLogs(client) {
  const processed = new Set(loadProcessed());
  let changed = false;

  console.log(`[JoinLogs] Starting legacy check. Guilds in cache: ${client.guilds.cache.size}`);

  for (const guild of client.guilds.cache.values()) {
    try {
      console.log(`[JoinLogs] Checking guild: ${guild.name} (${guild.id})`);
      const config = await getGuildConfig(guild.id);
      if (config && config.joinlogs) {
        console.log(`[JoinLogs] Found joinlogs config for ${guild.name}`);
        const { channel: channelId, pingRole, giveRole } = config.joinlogs;
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel) {
          console.log(`[JoinLogs] Could not fetch joinlogs channel ${channelId}`);
          continue;
        }

        const members = await guild.members.fetch();
        console.log(`[JoinLogs] Fetched ${members.size} members to check.`);
        let sentCount = 0;
        
        for (const member of members.values()) {
          if (member.user.bot) continue;
          
          if (member.roles.cache.has(giveRole)) {
            // Already has the role, no need to log
            if (!processed.has(member.id)) {
              processed.add(member.id);
              changed = true;
            }
            continue;
          }

          if (processed.has(member.id)) continue;

          console.log(`[JoinLogs] Sending legacy log for ${member.user.tag} (${member.id})`);
          // Needs a log!
          const embed = new EmbedBuilder()
            .setTitle('Legacy User Pending Info')
            .setDescription(`User: <@${member.user.id}>\n\n**Set name:** (Empty)\n**Email:** (Empty)\n**School:** (Empty)`)
            .setColor('Orange');

          const joinRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`join_fill_${member.user.id}_${giveRole}`)
              .setLabel('fill in information')
              .setStyle(ButtonStyle.Primary)
          );

          await channel.send({
            content: `<@&${pingRole}> (Legacy user missing role)`,
            embeds: [embed],
            components: [joinRow]
          });

          processed.add(member.id);
          changed = true;
          sentCount++;
        }
        console.log(`[JoinLogs] Sent ${sentCount} legacy logs for ${guild.name}.`);
      } else {
        console.log(`[JoinLogs] No joinlogs config for ${guild.name}`);
      }
    } catch (err) {
      console.error(`[JoinLogs] Error processing legacy join logs for guild ${guild.id}`, err);
    }
  }

  if (changed) {
    saveProcessed([...processed]);
    console.log('[JoinLogs] Saved processed file.');
  }
}

client.once('ready', () => {
  console.log(`Greeter bot logged in as ${client.user.tag}`);

  processLegacyJoinLogs(client);

  // Auto-join voice channel every 15 minutes for 30 seconds
  const TARGET_VOICE_CHANNEL_ID = '1547401974969012335';
  
  setInterval(async () => {
    try {
      const channel = await client.channels.fetch(TARGET_VOICE_CHANNEL_ID).catch(() => null);
      if (channel) {
        console.log(`Auto-joining voice channel ${channel.name} for 30 seconds...`);
        
        if (currentVoiceConnection) {
          currentVoiceConnection.destroy();
        }

        currentVoiceChannel = channel;
        currentVoiceConnection = joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: true,
          selfMute: true,
        });

        // Disconnect after 30 seconds
        setTimeout(() => {
          if (currentVoiceConnection && currentVoiceChannel?.id === TARGET_VOICE_CHANNEL_ID) {
            console.log(`Disconnecting from auto-joined voice channel ${channel.name}.`);
            currentVoiceConnection.destroy();
            currentVoiceConnection = null;
            currentVoiceChannel = null;
          }
        }, 30 * 1000);
      } else {
        console.log(`Auto-join failed: Could not find channel with ID ${TARGET_VOICE_CHANNEL_ID}`);
      }
    } catch (err) {
      console.error(`Error during auto-join interval:`, err);
    }
  }, 15 * 60 * 1000);
});

async function logToPanel(guildId, message) {
  try {
    await fetch(`${WORKER_URL}/api/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guild_id: guildId, message })
    });
  } catch (err) {
    console.error("Failed to log to panel", err);
  }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  // Trigger when joining a VC or switching VCs
  if (newState.channelId && oldState.channelId !== newState.channelId) {
    if (newState.member.user.bot) return;

    const channel = newState.channel;
    const guildId = channel.guild.id;
    
    await logToPanel(guildId, `User ${newState.member.user.tag} joined ${channel.name}. Checking config...`);

    // Fetch config to check for VC restrictions and get playlist URL
    const config = await getGuildConfig(guildId);
    if (config) {
      if (config.music_vc_id && channel.id !== config.music_vc_id) {
        await logToPanel(guildId, `Ignored: user joined ${channel.name}, but bot is restricted to <#${config.music_vc_id}>.`);
        return; // User joined a different VC, ignore
      }
      if (config.music_playlist_url) {
        currentPlaylistUrl = config.music_playlist_url;
      }
    }

    if (!currentVoiceConnection || currentVoiceChannel?.id !== channel.id) {
      console.log(`User joined VC. Bot joining ${channel.name} to play music.`);
      await logToPanel(guildId, `Joining ${channel.name} and starting music...`);
      
      if (currentVoiceConnection) {
        currentVoiceConnection.destroy();
      }

      currentVoiceChannel = channel;
      currentVoiceConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
      });

      currentVoiceConnection.subscribe(musicPlayer);

      if (!isPlayingMusic) {
        if (musicQueue.length === 0) {
          await logToPanel(guildId, `Loading playlist into queue...`);
          await loadPlaylist();
        }
        playNextSong();
      }
    } else {
      await logToPanel(guildId, `Bot is already in ${channel.name} playing music.`);
    }
  } else if (oldState.channelId && !newState.channelId) {
    const channel = oldState.channel;
    if (currentVoiceChannel && currentVoiceChannel.id === channel.id) {
      const members = channel.members.filter(m => !m.user.bot);
      if (members.size === 0) {
        console.log("VC is empty. Leaving and pausing music.");
        await logToPanel(channel.guild.id, `VC is empty. Pausing music and disconnecting...`);
        musicPlayer.pause();
        isPlayingMusic = false;
        currentVoiceConnection.destroy();
        currentVoiceConnection = null;
        currentVoiceChannel = null;
      }
    }
  }
});

const WORKER_URL = 'https://hcpss-worker.kodymcmonagle808.workers.dev';
const configCache = new Map();
const configCacheTime = new Map();

async function getGuildConfig(guildId) {
  const now = Date.now();
  if (configCache.has(guildId) && (now - configCacheTime.get(guildId) < 60000)) {
    return configCache.get(guildId);
  }
  try {
    const res = await fetch(`${WORKER_URL}/api/config?guild_id=${guildId}`);
    if (res.ok) {
      const config = await res.json();
      configCache.set(guildId, config);
      configCacheTime.set(guildId, now);
      return config;
    }
  } catch (err) {
    console.error(err);
  }
  return null;
}

client.on('messageCreate', async (message) => {
  if (message.content === '!greeter-ping') {
    await message.channel.send('Pong! The greeter bot is alive and reading messages.');
    return;
  }

  // Handle music channel message deletions and verification
  if (message.guild) {
    const config = await getGuildConfig(message.guild.id);
    if (config && config.music_channel_id && message.channel.id === config.music_channel_id) {
      // 1. Delete message after 5 seconds (except our own messages)
      if (message.author.id !== client.user.id) {
        setTimeout(() => {
          message.delete().catch(() => {});
        }, 5000);
      }

      // 2. Timeout logic if they use m!play incorrectly (only for non-bots)
      if (!message.author.bot && message.content.startsWith('m!play')) {
        const expectedLink = 'https://open.spotify.com/playlist/1Njedyj01AnBWG2MbUtCEt?si=QYOsPmOeQ7qQrIybyUcIuQ&utm_source=copy-link&pi=PIAugKKQTS29_&pt=6b3c22efcf12ac162e4f59e71c26b2c8';
        const isExpected = message.content.includes(expectedLink);
        
        if (!isExpected) {
          try {
            // Check if they are a temporary DJ
            const tempRes = await fetch(`${WORKER_URL}/api/temp_dj?guild_id=${message.guild.id}&user_id=${message.author.id}`);
            if (tempRes.ok) {
              const data = await tempRes.json();
              if (data.is_temp_dj) {
                // They are a temporary DJ but used the wrong link! Time them out for 30 minutes.
                await message.member.timeout(30 * 60 * 1000, 'Changed the normal play command link');
                
                // DM the server owner
                const owner = await message.guild.fetchOwner();
                if (owner) {
                  await owner.send(`⚠️ **Alert:** User ${message.author.tag} (${message.author.id}) was timed out for 30 minutes for trying to change the Normal Play command in the music channel.\nThey attempted to send: \`${message.content}\``).catch(() => {});
                }
              }
            }
          } catch (err) {
            console.error('Error checking temp_dj or timing out:', err);
          }
        }
      }
    }
  }

  // We can still log to console, but we'll also send status updates to the channel for the command
  if (message.content.startsWith('GREET_BOT_COMMAND: TOGGLE_VOICE')) {
    if (!message.author.bot) {
      await message.channel.send("❌ Ignoring command because it wasn't sent by a bot.");
      return;
    }

    const parts = message.content.split(' ');
    const targetChannelId = parts.length > 2 ? parts[2] : null;

    if (currentVoiceConnection) {
      await message.channel.send("🔌 Disconnecting from current voice channel...");
      currentVoiceConnection.destroy();
      currentVoiceConnection = null;
      currentVoiceChannel = null;
    }
    
    if (targetChannelId && targetChannelId !== 'LEAVE') {
      await message.channel.send(`🔍 Attempting to join voice channel ID: \`${targetChannelId}\`...`);
      const channel = await client.channels.fetch(targetChannelId).catch(err => {
        return null;
      });
      
      if (channel) {
        await message.channel.send(`✅ Found channel: **${channel.name}**. Joining now...`);
        currentVoiceChannel = channel;
        try {
          currentVoiceConnection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: true,
          });
          
          await message.channel.send("🎙️ Successfully called join mechanism!");
          
          currentVoiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
            if (!currentVoiceConnection) return;
            try {
              await Promise.race([
                entersState(currentVoiceConnection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(currentVoiceConnection, VoiceConnectionStatus.Connecting, 5_000),
              ]);
            } catch (error) {
              if (currentVoiceConnection) currentVoiceConnection.destroy();
              if (currentVoiceChannel) {
                 currentVoiceConnection = joinVoiceChannel({
                   channelId: currentVoiceChannel.id,
                   guildId: currentVoiceChannel.guild.id,
                   adapterCreator: currentVoiceChannel.guild.voiceAdapterCreator,
                   selfDeaf: true,
                   selfMute: true,
                 });
              }
            }
          });
        } catch (err) {
          await message.channel.send(`❌ Error while trying to join: ${err.message}`);
        }
      } else {
        await message.channel.send(`❌ Could not find or access a voice channel with ID \`${targetChannelId}\`. Make sure the bot has permissions to view it.`);
      }
    }
    
    // We will wait 5 seconds before deleting the trigger message so people can see the logs
    setTimeout(() => {
      message.delete().catch(() => {});
    }, 5000);
  }
});


client.on('guildMemberAdd', async (member) => {
  try {
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`greeter_roles_${member.guild.id}`)
        .setPlaceholder('Select the status notifications you want')
        .setMinValues(0)
        .setMaxValues(6)
        .addOptions([
          new StringSelectMenuOptionBuilder()
            .setLabel('Normal Operations')
            .setValue('normal_operations'),
          new StringSelectMenuOptionBuilder()
            .setLabel('Schools Closed')
            .setValue('schools_closed'),
          new StringSelectMenuOptionBuilder()
            .setLabel('Schools & Offices Closed')
            .setValue('schools_and_offices_closed'),
          new StringSelectMenuOptionBuilder()
            .setLabel('Schools Open 2 Hours Late')
            .setValue('schools_open_2_hours_late'),
          new StringSelectMenuOptionBuilder()
            .setLabel('Schools Close 3 Hours Early')
            .setValue('schools_close_3_hours_early'),
          new StringSelectMenuOptionBuilder()
            .setLabel('Other / Unknown Alerts')
            .setValue('unknown_alert'),
        ])
    );

    await member.send({
      content: `Hi! Welcome to **${member.guild.name}**. This server includes a bot that checks the HCPSS operating status and posts updates automatically.\n\nPlease select which status updates you would like to be notified (pinged) for:`,
      components: [row]
    });
    console.log(`Sent welcome DM to ${member.user.tag}`);
  } catch (error) {
    console.error(`Could not send welcome DM to ${member.user.tag}. They might have DMs disabled.`, error);
  }

  // Join logs logic
  try {
    const config = await getGuildConfig(member.guild.id);
    if (config && config.joinlogs) {
      const { channel: channelId, pingRole, giveRole } = config.joinlogs;
      const channel = await member.guild.channels.fetch(channelId).catch(() => null);
      if (channel) {
        const embed = new EmbedBuilder()
          .setTitle('New User Joined')
          .setDescription(`User: <@${member.user.id}>\n\n**Set name:** (Empty)\n**Email:** (Empty)\n**School:** (Empty)`)
          .setColor('Blue');
        
        const joinRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`join_fill_${member.user.id}_${giveRole}`)
            .setLabel('fill in information')
            .setStyle(ButtonStyle.Primary)
        );

        await channel.send({
          content: `<@&${pingRole}>`,
          embeds: [embed],
          components: [joinRow]
        });

        const processed = new Set(loadProcessed());
        processed.add(member.id);
        saveProcessed([...processed]);
      }
    }
  } catch (error) {
    console.error(`Error sending join logs for ${member.user.tag}`, error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith('join_fill_')) {
    const parts = interaction.customId.split('_');
    const userId = parts[2];
    const giveRole = parts[3];

    const modal = new ModalBuilder()
      .setCustomId(`join_modal_${userId}_${giveRole}`)
      .setTitle('Fill User Information');
        
    const nameInput = new TextInputBuilder()
      .setCustomId('user_name')
      .setLabel("Set name")
      .setStyle(TextInputStyle.Short);
        
    const emailInput = new TextInputBuilder()
      .setCustomId('user_email')
      .setLabel("Email")
      .setStyle(TextInputStyle.Short);

    const schoolInput = new TextInputBuilder()
      .setCustomId('user_school')
      .setLabel("School")
      .setStyle(TextInputStyle.Short);

    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(emailInput),
      new ActionRowBuilder().addComponents(schoolInput)
    );

    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('join_modal_')) {
    const parts = interaction.customId.split('_');
    const userId = parts[2];
    const giveRole = parts[3];

    const name = interaction.fields.getTextInputValue('user_name');
    const email = interaction.fields.getTextInputValue('user_email');
    const school = interaction.fields.getTextInputValue('user_school');

    const embed = EmbedBuilder.from(interaction.message.embeds[0]);
    embed.setDescription(`User: <@${userId}>\n\n**Set name:** ${name}\n**Email:** ${email}\n**School:** ${school}`);

    await interaction.message.edit({
      embeds: [embed],
      components: []
    });
    
    try {
      const member = await interaction.guild.members.fetch(userId);
      if (member) {
        await member.roles.add(giveRole);
        try {
          await member.setNickname(name);
        } catch (nickError) {
          console.error('Failed to set nickname for user', nickError);
        }
      }
    } catch (e) {
      console.error('Failed to assign role to user', e);
    }

    return interaction.reply({ content: 'Information updated and role assigned.', ephemeral: true });
  }

  // If the interaction is not a select menu in a DM, ignore
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith('greeter_roles_')) return;

  const guildId = interaction.customId.replace('greeter_roles_', '');
  
  try {
    const guild = await client.guilds.fetch(guildId);
    if (!guild) {
      return interaction.reply({ content: 'Could not find the server. You might have left it.', ephemeral: true });
    }

    const member = await guild.members.fetch(interaction.user.id);
    if (!member) {
      return interaction.reply({ content: 'Could not find you in the server.', ephemeral: true });
    }

    // Fetch all roles in the server
    const allRoles = await guild.roles.fetch();
    
    // Determine which role IDs the user should have based on their selection
    const selectedRoleNames = interaction.values.map(val => ROLE_MAPPINGS[val]);
    const allNotificationRoleNames = Object.values(ROLE_MAPPINGS);

    const rolesToAdd = [];
    const rolesToRemove = [];

    allRoles.forEach(role => {
      // Is this one of our managed notification roles?
      if (allNotificationRoleNames.includes(role.name)) {
        if (selectedRoleNames.includes(role.name)) {
          rolesToAdd.push(role);
        } else {
          rolesToRemove.push(role);
        }
      }
    });

    if (rolesToAdd.length > 0) {
      await member.roles.add(rolesToAdd);
    }
    if (rolesToRemove.length > 0) {
      await member.roles.remove(rolesToRemove);
    }

    await interaction.reply({
      content: '✅ Your notification preferences have been successfully updated for **' + guild.name + '**!',
      ephemeral: true
    });
    
    // Edit original message to remove the menu so they know it worked
    await interaction.message.edit({
      content: interaction.message.content,
      components: []
    });

  } catch (error) {
    console.error('Error handling role assignment:', error);
    if (!interaction.replied) {
      await interaction.reply({ content: 'An error occurred while assigning your roles. Make sure the bot has the correct permissions (Manage Roles) and its role is placed above the notification roles.', ephemeral: true });
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
