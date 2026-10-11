require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, StreamType } = require('@discordjs/voice');
const { Readable } = require('stream');
const ffmpegStatic = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegStatic;

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
let activeMusicTextChannel = null;

const musicPlayer = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Play,
  },
});

let innertubeClient = null;
async function getInnertube() {
  if (!innertubeClient) {
    const { Innertube } = await import('youtubei.js');
    innertubeClient = await Innertube.create();
  }
  return innertubeClient;
}

let playlistTracks = [];
let musicQueue = [];
let isPlayingMusic = false;
let currentPlaylistUrl = process.env.PLAYLIST_URL || 'https://open.spotify.com/playlist/1Njedyj01AnBWG2MbUtCEt?si=a4658eaa73b64ba4';

async function loadPlaylist(targetUrl) {
  const url = targetUrl || currentPlaylistUrl;
  try {
    if (url.includes('spotify.com')) {
      const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
      if (match) {
        const playlistId = match[1];
        console.log(`Scraping Spotify playlist metadata for: ${playlistId}`);
        const res = await fetch(`https://open.spotify.com/embed/playlist/${playlistId}`);
        const html = await res.text();
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (nextDataMatch) {
          const parsed = JSON.parse(nextDataMatch[1]);
          const entity = parsed?.props?.pageProps?.state?.data?.entity;
          if (entity && Array.isArray(entity.trackList)) {
            playlistTracks = entity.trackList.map(t => ({
              title: t.title,
              artist: t.subtitle,
              query: `${t.title} ${t.subtitle}`.trim(),
              preview: t.audioPreview ? t.audioPreview.url : null
            }));
            musicQueue = [...playlistTracks];
            console.log(`Loaded ${musicQueue.length} tracks from Spotify playlist "${entity.name}".`);
            return;
          }
        }
      }
    } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
      const yt = await getInnertube();
      const playlist = await yt.getPlaylist(url).catch(() => null);
      if (playlist && playlist.videos) {
        playlistTracks = playlist.videos.map(v => ({
          title: v.title?.text || 'YouTube Track',
          videoId: v.id,
          query: v.id
        }));
        musicQueue = [...playlistTracks];
        console.log(`Loaded ${musicQueue.length} tracks from YouTube playlist.`);
        return;
      }
    }
  } catch (err) {
    console.error("Error loading playlist:", err);
  }

  if (musicQueue.length === 0) {
    console.log("Using default fallback tracks in queue.");
    playlistTracks = [
      { title: 'Lofi Hip Hop Radio', query: 'lofi hip hop radio beats to relax study to' }
    ];
    musicQueue = [...playlistTracks];
  }
}

async function resolveTrack(input) {
  if (!input) return null;
  if (typeof input !== 'string') return input;
  const str = input.trim();
  if (str.includes('spotify.com')) {
    const trackMatch = str.match(/track\/([a-zA-Z0-9]+)/);
    if (trackMatch) {
      const trackId = trackMatch[1];
      try {
        const res = await fetch(`https://open.spotify.com/embed/track/${trackId}`);
        const html = await res.text();
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (nextDataMatch) {
          const parsed = JSON.parse(nextDataMatch[1]);
          const entity = parsed?.props?.pageProps?.state?.data?.entity;
          if (entity) {
            const title = entity.title || entity.name || 'Spotify Track';
            const artist = entity.subtitle || entity.artist || '';
            return {
              title,
              artist,
              query: `${title} ${artist}`.trim(),
              preview: entity.audioPreview ? entity.audioPreview.url : null
            };
          }
        }
      } catch (err) {
        console.error('Error resolving Spotify track:', err);
      }
    }
  }
  return { query: str, title: str };
}

async function playNextSong(textChannel) {
  if (textChannel) activeMusicTextChannel = textChannel;
  if (!currentVoiceConnection) {
    isPlayingMusic = false;
    return;
  }

  if (musicQueue.length === 0) {
    if (playlistTracks.length > 0) {
      musicQueue = [...playlistTracks];
    } else {
      await loadPlaylist();
    }
    if (musicQueue.length === 0) {
      isPlayingMusic = false;
      return;
    }
  }

  const trackItem = musicQueue.shift();
  let trackQuery = typeof trackItem === 'string' ? trackItem : (trackItem.query || trackItem.title);
  let songTitle = typeof trackItem === 'object' && trackItem.title ? `${trackItem.title}${trackItem.artist ? ` - ${trackItem.artist}` : ''}` : trackQuery;

  try {
    const yt = await getInnertube();
    let videoId = null;

    if (trackItem && trackItem.videoId) {
      videoId = trackItem.videoId;
    } else if (typeof trackQuery === 'string' && trackQuery.startsWith('http')) {
      const idMatch = trackQuery.match(/(?:v=|\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (idMatch) {
        videoId = idMatch[1];
      }
    }

    if (!videoId) {
      const search = await yt.search(trackQuery);
      const video = search.videos?.[0];
      if (video) {
        videoId = video.id;
        if (!trackItem.title) {
          songTitle = video.title?.text || songTitle;
        }
      }
    }

    let stream = null;
    if (videoId) {
      const { downloadMultiStep } = require('simple-ytdl-core');
      stream = await downloadMultiStep(yt, videoId).catch(err => {
        console.error(`downloadMultiStep failed for ${videoId}:`, err.message);
        return null;
      });
    }

    if (!stream && trackItem.preview) {
      console.log(`Falling back to Spotify audio preview for: ${songTitle}`);
      const res = await fetch(trackItem.preview).catch(() => null);
      if (res && res.ok) {
        stream = Readable.fromWeb(res.body);
      }
    }

    if (!stream) {
      console.log(`Could not stream: "${songTitle}". Moving to next track...`);
      setTimeout(() => playNextSong(activeMusicTextChannel), 1500);
      return;
    }

    const resource = createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true
    });
    if (resource.volume) {
      resource.volume.setVolume(1.0);
    }

    musicPlayer.play(resource);
    isPlayingMusic = true;
    console.log(`Now playing: ${songTitle}`);

    if (activeMusicTextChannel) {
      const m = await activeMusicTextChannel.send(`🎶 Now playing: **${songTitle}**`).catch(() => null);
      if (m) setTimeout(() => m.delete().catch(() => {}), 7000);
    }
  } catch (err) {
    console.error(`Error playing track "${songTitle}":`, err);
    setTimeout(() => playNextSong(activeMusicTextChannel), 2000);
  }
}

musicPlayer.on(AudioPlayerStatus.Idle, () => {
  isPlayingMusic = false;
  playNextSong(activeMusicTextChannel);
});

musicPlayer.on('error', error => {
  console.error('AudioPlayer error:', error.message);
  isPlayingMusic = false;
  setTimeout(() => playNextSong(activeMusicTextChannel), 2000);
});

client.once('ready', () => {
  console.log(`Greeter bot logged in as ${client.user.tag}`);

  // Set the bot's Discord presence / status
  client.user.setPresence({
    activities: [{ name: 'HCPSS Status', type: ActivityType.Watching }],
    status: 'online',
  });
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
  if (oldState.channelId && !newState.channelId) {
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
  if (message.content.startsWith('GREET_BOT_COMMAND:')) {
    if (!message.author.bot) {
      return;
    }

    const content = message.content.trim();
    // Delete the trigger message right away
    message.delete().catch(() => {});

    // Helper to start playback in a channel
    const playInVoice = async (vc) => {
      if (currentVoiceConnection) {
        currentVoiceConnection.destroy();
      }
      currentVoiceChannel = vc;
      currentVoiceConnection = joinVoiceChannel({
        channelId: vc.id,
        guildId: vc.guild.id,
        adapterCreator: vc.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
      });

      currentVoiceConnection.subscribe(musicPlayer);

      currentVoiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (!currentVoiceConnection) return;
        try {
          await Promise.race([
            entersState(currentVoiceConnection, VoiceConnectionStatus.Signalling, 5000),
            entersState(currentVoiceConnection, VoiceConnectionStatus.Connecting, 5000),
          ]);
        } catch {
          if (currentVoiceConnection) currentVoiceConnection.destroy();
          currentVoiceConnection = null;
          currentVoiceChannel = null;
          isPlayingMusic = false;
        }
      });

      if (!isPlayingMusic) {
        if (musicQueue.length === 0) {
          await loadPlaylist();
        }
        playNextSong(message.channel);
      }
    };

    if (content.startsWith('GREET_BOT_COMMAND: JOIN') || content.startsWith('GREET_BOT_COMMAND: TOGGLE_VOICE')) {
      const parts = content.split(' ');
      const userId = parts[2];
      const fallbackChannelId = parts[3];

      let targetVc = null;
      if (userId && userId !== 'LEAVE') {
        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (member && member.voice && member.voice.channel) {
          targetVc = member.voice.channel;
        }
      }
      if (!targetVc && fallbackChannelId && fallbackChannelId !== 'LEAVE') {
        targetVc = await message.guild.channels.fetch(fallbackChannelId).catch(() => null);
      }
      if (!targetVc && userId && userId !== 'LEAVE') {
        // userId might actually be a channel ID (from TOGGLE_VOICE)
        targetVc = await message.guild.channels.fetch(userId).catch(() => null);
      }

      // Check if LEAVE command or toggle off
      if (userId === 'LEAVE' || fallbackChannelId === 'LEAVE') {
        if (currentVoiceConnection) {
          musicPlayer.pause();
          isPlayingMusic = false;
          currentVoiceConnection.destroy();
          currentVoiceConnection = null;
          currentVoiceChannel = null;
        }
        const m = await message.channel.send('🔌 Disconnected from voice.').catch(() => null);
        if (m) setTimeout(() => m.delete().catch(() => {}), 5000);
        return;
      }

      if (!targetVc) {
        const m = await message.channel.send('❌ Please join a voice channel first (or set a default Voice Channel in the Control Panel).').catch(() => null);
        if (m) setTimeout(() => m.delete().catch(() => {}), 5000);
        return;
      }

      // If already in that VC, toggle off (disconnect)
      if (currentVoiceConnection && currentVoiceChannel && currentVoiceChannel.id === targetVc.id) {
        musicPlayer.pause();
        isPlayingMusic = false;
        currentVoiceConnection.destroy();
        currentVoiceConnection = null;
        currentVoiceChannel = null;
        const m = await message.channel.send(`🔌 Disconnected from **${targetVc.name}**.`).catch(() => null);
        if (m) setTimeout(() => m.delete().catch(() => {}), 5000);
        return;
      }

      await playInVoice(targetVc);
      const m = await message.channel.send(`🎶 Joined **${targetVc.name}** and started playing!`).catch(() => null);
      if (m) setTimeout(() => m.delete().catch(() => {}), 5000);
      return;
    }

    if (content.startsWith('GREET_BOT_COMMAND: PLAY_NORMAL')) {
      const parts = content.split(' ');
      const userId = parts[2];

      const config = await getGuildConfig(message.guild.id);
      if (config && config.music_playlist_url) {
        currentPlaylistUrl = config.music_playlist_url;
      } else {
        currentPlaylistUrl = 'https://open.spotify.com/playlist/1Njedyj01AnBWG2MbUtCEt?si=a4658eaa73b64ba4';
      }

      musicQueue = [];
      await loadPlaylist();

      if (!currentVoiceConnection) {
        let targetVc = null;
        if (userId) {
          const member = await message.guild.members.fetch(userId).catch(() => null);
          if (member && member.voice && member.voice.channel) {
            targetVc = member.voice.channel;
          }
        }
        if (!targetVc && config && config.music_vc_id) {
          targetVc = await message.guild.channels.fetch(config.music_vc_id).catch(() => null);
        }
        if (targetVc) {
          await playInVoice(targetVc);
        }
      } else {
        playNextSong(message.channel);
      }

      const m = await message.channel.send('▶️ Playing normal 24/7 playlist!').catch(() => null);
      if (m) setTimeout(() => m.delete().catch(() => {}), 5000);
      return;
    }

    if (content.startsWith('GREET_BOT_COMMAND: PLAY_SONG')) {
      const parts = content.split(' ');
      const songUrl = parts[2];
      const userId = parts[3];

      if (songUrl) {
        let queuedName = songUrl;
        if (songUrl.includes('spotify.com/playlist/')) {
          await loadPlaylist(songUrl);
          queuedName = 'Spotify Playlist';
        } else {
          const resolved = await resolveTrack(songUrl);
          musicQueue.unshift(resolved);
          queuedName = resolved.title || resolved.query || songUrl;
        }

        if (!currentVoiceConnection) {
          const config = await getGuildConfig(message.guild.id);
          let targetVc = null;
          if (userId) {
            const member = await message.guild.members.fetch(userId).catch(() => null);
            if (member && member.voice && member.voice.channel) {
              targetVc = member.voice.channel;
            }
          }
          if (!targetVc && config && config.music_vc_id) {
            targetVc = await message.guild.channels.fetch(config.music_vc_id).catch(() => null);
          }
          if (targetVc) {
            await playInVoice(targetVc);
          }
        } else if (!isPlayingMusic) {
          playNextSong(message.channel);
        }

        const m = await message.channel.send(`🎵 Queued: **${queuedName}**`).catch(() => null);
        if (m) setTimeout(() => m.delete().catch(() => {}), 5000);
      }
      return;
    }
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
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`join_bot_${member.user.id}`)
              .setLabel('Bot')
              .setStyle(ButtonStyle.Secondary)
          );

        await channel.send({
          content: `<@&${pingRole}>`,
          embeds: [embed],
          components: [joinRow]
        });
      }
    }
  } catch (error) {
    console.error(`Error sending join logs for ${member.user.tag}`, error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith('join_bot_')) {
    const parts = interaction.customId.split('_');
    const userId = parts[2];

    const embed = EmbedBuilder.from(interaction.message.embeds[0]);
    embed.setDescription(`User: <@${userId}>\n\n**Status:** Marked as Bot (skipped information)`);
    embed.setColor('Green');

    // Acknowledge immediately to Discord so it never hangs with "Interaction received."
    await interaction.update({
      embeds: [embed],
      components: []
    }).catch(() => {});

    try {
      const allRoles = await interaction.guild.roles.fetch();
      const botRole = allRoles.find(r => {
        const n = (r.name || '').toLowerCase();
        return n === 'bot' || n === 'bots' || n === 'bot role' || n === 'bot rules' || n === 'bots role';
      });

      if (botRole) {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (member) {
          await member.roles.add(botRole).catch(() => {});
          await interaction.followUp({ content: `✅ <@${userId}> was marked as a bot and assigned the **${botRole.name}** role.`, ephemeral: true }).catch(() => {});
        }
      } else {
        await interaction.followUp({ content: `✅ <@${userId}> was marked as a bot (skipped information). Note: No server role named 'Bot' was found.`, ephemeral: true }).catch(() => {});
      }
    } catch (e) {
      console.error('Failed to assign bot role in join_bot_:', e);
    }
    return;
  }

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

// --- Keep-Alive Web Server for Render ---
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Greeter Bot is alive and watching HCPSS Status!');
});

app.listen(port, () => {
  console.log(`Keep-alive web server listening on port ${port}`);
});
