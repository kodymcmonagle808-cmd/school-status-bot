require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, StreamType } = require('@discordjs/voice');
const { Readable } = require('stream');
const play = require('play-dl');
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
let isExplicitlyDisconnected = false;
let isPlayingErrorTTS = false;
let lastErrorTTSTime = 0;
let emergencyMode = false;

// Music is enabled in Discord. Flip this to false to temporarily disable the
// 24/7 auto-join and voice runtime without deleting any playback code.
const MUSIC_ENABLED = true;

const musicPlayer = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Play,
  },
});

async function playAudioErrorMessage(text) {
  if (!currentVoiceConnection) return;
  // Prevent TTS spam — only allow one TTS every 30 seconds
  const now = Date.now();
  if (now - lastErrorTTSTime < 30000) {
    console.log('Skipping TTS error (cooldown active).');
    return;
  }
  lastErrorTTSTime = now;
  try {
    console.log(`🔊 Playing audio error message in VC: "${text}"`);
    isPlayingErrorTTS = true;
    const cleanText = text.replace(/[^a-zA-Z0-9 ,.?!'-]/g, ' ').slice(0, 100);
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encodeURIComponent(cleanText)}`;
    const resource = createAudioResource(ttsUrl, {
      inputType: StreamType.Arbitrary,
      inlineVolume: false
    });
    musicPlayer.play(resource);
    isPlayingMusic = true;
  } catch (err) {
    console.error('Failed to play error TTS:', err);
    isPlayingErrorTTS = false;
  }
}

let innertubeClient = null;
async function getInnertube() {
  if (!innertubeClient) {
    const { Innertube, Log } = await import('youtubei.js');
    Log.setLevel(Log.Level.ERROR);
    innertubeClient = await Innertube.create();
  }
  return innertubeClient;
}

// Drop the cached Innertube session so the next getInnertube() builds a fresh
// one. A long-lived session's tokens/visitor data can go stale, after which
// every getBasicInfo/stream call fails — which looks like "it played once then
// never again." Recreating the client clears that.
function resetInnertube() {
  try { if (innertubeClient && innertubeClient.session) innertubeClient.session.destroy?.(); } catch {}
  innertubeClient = null;
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
              query: `${t.title} ${t.subtitle} official audio`.trim(),
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
      { title: 'Eternity', artist: 'Alex Warren', query: 'Eternity Alex Warren official audio' },
      { title: 'The Outside', artist: 'Alex Warren', query: 'The Outside Alex Warren official audio' },
      { title: 'You’ll Be Alright, Kid', artist: 'Alex Warren', query: 'You’ll Be Alright Kid Alex Warren official audio' },
      { title: 'Never Be Far', artist: 'Alex Warren', query: 'Never Be Far Alex Warren official audio' },
      { title: 'Save You a Seat', artist: 'Alex Warren', query: 'Save You a Seat Alex Warren official audio' }
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
              query: `${title} ${artist} official audio`.trim(),
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

// Initialize SoundCloud client_id for play-dl fallback
let scInitialized = false;
async function initSoundCloud() {
  if (scInitialized) return;
  try {
    const clientId = await play.getFreeClientID();
    await play.setToken({ soundcloud: { client_id: clientId } });
    scInitialized = true;
    console.log('SoundCloud client initialized for fallback streaming.');
  } catch (err) {
    console.error('SoundCloud init failed (non-fatal):', err.message);
  }
}

// Patterns that mark a video as the WRONG version of a song (remix, cover,
// slowed/sped-up, live, lyric video, long mixes, etc.). A hit strongly
// deprioritizes the candidate so the official studio version wins.
const BAD_VERSION_PATTERNS = [
  /\bremix\b/i, /\bcover(ed|ing)?\b/i, /\bslowed\b/i, /\bsped[\s-]?up\b/i,
  /\bspeed[\s-]?up\b/i, /\breverb\b/i, /\bnightcore\b/i, /\b8d\b/i,
  /\bbass[\s-]?boosted\b/i, /\blive\b/i, /\bacoustic\b/i, /\binstrumental\b/i,
  /\bkaraoke\b/i, /\blyrics?\b/i, /\btribute\b/i, /\bparody\b/i,
  /\bmashup\b/i, /\bmash[\s-]?up\b/i, /\bfull album\b/i, /\bextended\b/i,
  /\bradio edit\b/i, /\b\d+\s*(hour|hours|hr)\b/i, /\bnon[\s-]?stop\b/i
];

// Patterns that mark a video as a likely OFFICIAL upload.
const GOOD_VERSION_PATTERNS = [
  /\bofficial\b/i, /\bprovided to youtube\b/i, /\bauto[\s-]?generated\b/i, /\bvevo\b/i
];

// Score a YouTube search result against the track we actually want so the
// correct studio version is tried first and wrong versions are skipped.
function scoreVideoCandidate(v, wantTitle, wantArtist) {
  const title = (v.title?.text || '').toLowerCase();
  const author = (v.author?.name || '').toLowerCase();
  const wt = (wantTitle || '').toLowerCase();
  const wa = (wantArtist || '').toLowerCase();
  let score = 0;

  for (const re of BAD_VERSION_PATTERNS) if (re.test(title)) score -= 100;
  for (const re of GOOD_VERSION_PATTERNS) if (re.test(title)) score += 12;

  if (/- topic$/.test(author) || author.includes('topic')) score += 18;
  if (author.includes('vevo')) score += 18;
  if (v.author?.is_verified_artist) score += 12;

  if (wt && title.includes(wt)) score += 40;
  if (wa && (title.includes(wa) || author.includes(wa))) score += 30;

  const secs = v.duration?.seconds || 0;
  if (secs && secs < 45) score -= 120;   // teaser / snippet
  if (secs && secs > 900) score -= 60;   // likely a long mix / loop

  return score;
}

function rankVideoCandidates(videos, wantTitle, wantArtist) {
  return (videos || [])
    .filter(v => v && v.id && v.is_live !== true)
    .map(v => ({ v, score: scoreVideoCandidate(v, wantTitle, wantArtist) }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.v);
}

// YouTube Music returns canonical studio tracks (item_type === "song"), which
// is the single most reliable source for the exact version of a song. We apply
// the "Songs" filter to get a clean shelf, then rank so the official studio cut
// wins over the occasional "sped up"/"8D"/by-another-artist entry that can
// still appear in the results.
async function searchYouTubeMusicSongs(yt, query, wantTitle = '', wantArtist = '') {
  try {
    const search = await yt.music.search(query);
    let shelf = search.songs;
    if (!shelf && typeof search.applyFilter === 'function') {
      // The unfiltered page returns a top-result card instead of a songs shelf;
      // applying the "Songs" filter produces the canonical track list.
      const filtered = await search.applyFilter('Songs').catch(() => null);
      shelf = filtered && filtered.songs;
    }
    const items = (shelf && shelf.contents) || [];
    const wt = (wantTitle || '').toLowerCase();
    const wa = (wantArtist || '').toLowerCase();
    const scored = items
      .filter(item => item && item.item_type === 'song' && item.id)
      .map(item => {
        const title = item.title || '';
        const artist =
          (item.artists && item.artists[0] && item.artists[0].name) ||
          (item.authors && item.authors[0] && item.authors[0].name) || '';
        let score = 0;
        const lt = title.toLowerCase();
        const la = artist.toLowerCase();
        if (BAD_VERSION_PATTERNS.some(re => re.test(title))) score -= 100;
        if (wt && lt.includes(wt)) score += 40;
        if (wa && la.includes(wa)) score += 40;       // canonical entry is by the real artist
        else if (wa && lt.includes(wa)) score += 15;
        return { id: item.id, title, artist, score };
      })
      .sort((a, b) => b.score - a.score);
    return scored;
  } catch (err) {
    console.log(`[YouTube Music] Search failed for "${query}": ${err.message}`);
    return [];
  }
}

// Resolve a playable audio stream for a video id with a hard timeout and a
// protocol fallback. downloadMultiStep's adaptive path relies on BotGuard /
// PoToken minting (jsdom-heavy); on some hosts (e.g. Render) that can hang or
// throw, which previously surfaced as "unable to stream audio". We bound each
// attempt with a timeout and fall back to the SABR protocol, which uses a
// different extraction path.
const STREAM_TIMEOUT_MS = 20000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function getStreamForVideo(yt, videoId) {
  const { downloadMultiStep } = require('simple-ytdl-core');

  // Attempt 1: adaptive multi-step (VISIONOS needs no PoToken; others need
  // BotGuard). This is the fast path and works without jsdom on most hosts.
  try {
    const stream = await withTimeout(downloadMultiStep(yt, videoId), STREAM_TIMEOUT_MS, `adaptive ${videoId}`);
    if (stream && stream.readable !== false) return stream;
  } catch (err) {
    console.log(`[stream] adaptive failed for ${videoId}: ${err.message}`);
  }

  // Attempt 2: SABR protocol — a different server-side path that also mints a
  // PoToken but streams via Server ABR. Worth trying when adaptive is blocked.
  try {
    const stream = await withTimeout(downloadMultiStep(yt, videoId, undefined, 'SABR'), STREAM_TIMEOUT_MS, `sabr ${videoId}`);
    if (stream && stream.readable !== false) return stream;
  } catch (err) {
    console.log(`[stream] SABR failed for ${videoId}: ${err.message}`);
  }

  return null;
}

// Multi-provider full audio stream resolver.
// NEVER falls back to Spotify 30s previews — only full-length songs, and always
// the correct version (YouTube Music canonical tracks first, then ranked YT).
async function getFullAudioStream(yt, trackQuery, songTitle, meta = {}) {
  const wantTitle = meta.title || '';
  const wantArtist = meta.artist || '';
  const cleanQuery =
    [wantTitle, wantArtist].filter(Boolean).join(' ').trim() ||
    trackQuery.replace(/official audio/gi, '').replace(/\s+/g, ' ').trim();

  // --- Provider 0: YouTube Music (canonical studio tracks, exact version) ---
  const musicSongs = await searchYouTubeMusicSongs(yt, cleanQuery, wantTitle, wantArtist);
  for (const s of musicSongs.slice(0, 5)) {
    try {
      const stream = await getStreamForVideo(yt, s.id);
      if (stream) {
        console.log(`[YouTube Music] Canonical track: "${s.title}" by "${s.artist}" (${s.id})`);
        return { stream, source: 'YouTube Music', resolvedTitle: `${s.title}${s.artist ? ` - ${s.artist}` : ''}` };
      }
    } catch (err) {
      console.log(`[YouTube Music] Candidate ${s.id} failed: ${err.message}`);
    }
  }

  // --- Provider 1: YouTube search, ranked to skip wrong versions ---
  try {
    const search = await yt.search(cleanQuery);
    const ranked = rankVideoCandidates(search.videos, wantTitle, wantArtist);
    for (const v of ranked.slice(0, 8)) {
      try {
        const stream = await getStreamForVideo(yt, v.id);
        if (stream) {
          console.log(`[YouTube] Ranked match: "${v.title?.text}" by "${v.author?.name}" (${v.id})`);
          return { stream, source: 'YouTube', resolvedTitle: v.title?.text || songTitle };
        }
      } catch (err) {
        console.log(`[YouTube] Candidate ${v.id} failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.log(`[YouTube] Primary search failed for "${cleanQuery}": ${err.message}`);
  }

  // --- Provider 2: YouTube (secondary search with "audio" appended), ranked ---
  try {
    const audioQuery = `${cleanQuery} audio`;
    console.log(`[YouTube] Trying secondary query: "${audioQuery}"`);
    const search2 = await yt.search(audioQuery);
    const ranked2 = rankVideoCandidates(search2.videos, wantTitle, wantArtist);
    for (const v of ranked2.slice(0, 6)) {
      try {
        const stream = await getStreamForVideo(yt, v.id);
        if (stream) {
          console.log(`[YouTube] Full stream via secondary search: "${v.title?.text}" (${v.id})`);
          return { stream, source: 'YouTube', resolvedTitle: v.title?.text || songTitle };
        }
      } catch (err) {
        console.log(`[YouTube] Secondary candidate ${v.id} failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.log(`[YouTube] Secondary search failed: ${err.message}`);
  }

  // --- Provider 3: Official SoundCloud track (never remixes, covers, or slowed) ---
  try {
    await initSoundCloud();
    // Clean query: strip "official audio" when searching SoundCloud
    const scQuery = cleanQuery;
    console.log(`[SoundCloud] Searching for clean track: "${scQuery}"`);
    const scResults = await play.search(scQuery, { source: { soundcloud: 'tracks' }, limit: 8 });
    const wt = wantTitle.toLowerCase();
    const wa = wantArtist.toLowerCase();
    const scScore = (t) => {
      const name = (t.name || '').toLowerCase();
      const author = (t.user?.name || '').toLowerCase();
      let s = 0;
      if (BAD_VERSION_PATTERNS.some(re => re.test(name))) s -= 100;
      if (wt && name.includes(wt)) s += 40;
      if (wa && (name.includes(wa) || author.includes(wa))) s += 30;
      return s;
    };
    const cleanTrack = [...scResults]
      .filter(t => t && t.url)
      .sort((a, b) => scScore(b) - scScore(a))[0];

    if (cleanTrack) {
      console.log(`[SoundCloud] Found clean match: "${cleanTrack.name}" by "${cleanTrack.user?.name}"`);
      const scStream = await play.stream(cleanTrack.url);
      if (scStream && scStream.stream) {
        return { stream: scStream.stream, source: 'SoundCloud', resolvedTitle: cleanTrack.name || songTitle };
      }
    }
  } catch (err) {
    console.log(`[SoundCloud] Fallback failed: ${err.message}`);
  }

  return null; // All providers exhausted
}

let consecutiveSkipCount = 0;
let isLoadingSong = false;

async function playNextSong(textChannel) {
  if (emergencyMode) {
    console.log('🚨 Emergency mode: skipping playNextSong.');
    isPlayingMusic = false;
    return;
  }
  if (textChannel) activeMusicTextChannel = textChannel;
  if (!currentVoiceConnection) {
    // No voice connection yet. This is the usual reason "nothing is playing":
    // the bot hasn't joined a VC (no Voice Channel configured, or Join wasn't
    // pressed). Log it once per call so the Render logs make the cause obvious.
    isPlayingMusic = false;
    console.log('playNextSong: no active voice connection — not in a voice channel. ' +
      'Set a Voice Channel in Music Settings or press Join while in a VC.');
    return;
  }
  if (isLoadingSong) {
    console.log('playNextSong already resolving a track, skipping concurrent invocation.');
    return;
  }
  isLoadingSong = true;

  if (musicQueue.length === 0) {
    if (playlistTracks.length > 0) {
      console.log('End of queue reached. Looping back to start of playlist...');
      musicQueue = [...playlistTracks];
    } else {
      await loadPlaylist();
      if (playlistTracks.length > 0) {
        musicQueue = [...playlistTracks];
      }
    }
    if (musicQueue.length === 0) {
      console.log('Queue empty; retrying in 5 seconds to keep 24/7 playback looping...');
      isLoadingSong = false;
      setTimeout(() => playNextSong(activeMusicTextChannel), 5000);
      return;
    }
  }

  const trackItem = musicQueue.shift();
  let trackQuery = typeof trackItem === 'string' ? trackItem : (trackItem.query || trackItem.title);
  let songTitle = typeof trackItem === 'object' && trackItem.title ? `${trackItem.title}${trackItem.artist ? ` - ${trackItem.artist}` : ''}` : trackQuery;

  try {
    const yt = await getInnertube();

    // If we already have a videoId, try it directly first
    let videoId = null;
    if (trackItem && trackItem.videoId) {
      videoId = trackItem.videoId;
    } else if (typeof trackQuery === 'string' && trackQuery.startsWith('http')) {
      const idMatch = trackQuery.match(/(?:v=|\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (idMatch) {
        videoId = idMatch[1];
      }
    }

    let stream = null;
    let audioSource = 'Unknown';

    if (videoId) {
      // Direct videoId — resolve with timeout + protocol fallback
      stream = await getStreamForVideo(yt, videoId).catch(err => {
        console.log(`[YouTube] Direct videoId ${videoId} failed: ${err.message}`);
        return null;
      });
      if (stream) audioSource = 'YouTube';
    }

    // If no stream yet, use multi-provider resolver
    if (!stream) {
      const result = await getFullAudioStream(yt, trackQuery, songTitle, {
        title: (trackItem && trackItem.title) || '',
        artist: (trackItem && trackItem.artist) || ''
      });
      if (result) {
        stream = result.stream;
        audioSource = result.source;
        // Only use the YouTube title if we don't have a clean Spotify title
        if (!trackItem.title || trackItem.title === 'YouTube Track') {
          songTitle = result.resolvedTitle || songTitle;
        }
      }
    }

    // NEVER fall back to Spotify 30s preview — skip track instead
    if (!stream) {
      consecutiveSkipCount++;
      console.log(`❌ Could not stream: "${songTitle}". (${consecutiveSkipCount} in a row)`);
      if (consecutiveSkipCount >= 3) {
        console.log('3 tracks failed in a row. Resetting YouTube session and pausing 30s before retrying 24/7 playback...');
        // A stale Innertube session is the usual cause of a sudden wall of
        // stream failures; rebuild it so the retry starts clean.
        resetInnertube();
        if (activeMusicTextChannel) {
          const m = await activeMusicTextChannel.send('⚠️ Playback temporarily paused: unable to stream audio. Retrying in 30 seconds...').catch(() => null);
          if (m) setTimeout(() => m.delete().catch(() => {}), 10000);
        }
        consecutiveSkipCount = 0;
        setTimeout(() => playNextSong(activeMusicTextChannel), 30000);
        return;
      }
      setTimeout(() => playNextSong(activeMusicTextChannel), 2000);
      return;
    }

    consecutiveSkipCount = 0;

    const resource = createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
      inlineVolume: false
    });
    if (resource.volume) {
      resource.volume.setVolume(1.0);
    }

    musicPlayer.play(resource);
    // Guarantee audible playback: the shared player can be left in a Paused
    // state by an earlier pause()/stop() path, and play() alone does not unpause
    // it — the track would load silently until someone hit Resume. Force it
    // back to Playing so a freshly loaded track always makes sound.
    if (musicPlayer.state.status === AudioPlayerStatus.Paused) {
      musicPlayer.unpause();
    }
    isPlayingMusic = true;
    console.log(`🎶 Now playing (${audioSource}): ${songTitle} [player state after play: ${musicPlayer.state.status}]`);

    if (activeMusicTextChannel) {
      const m = await activeMusicTextChannel.send(`🎶 Now playing: **${songTitle}**`).catch(() => null);
      if (m) setTimeout(() => m.delete().catch(() => {}), 7000);
    }
  } catch (err) {
    console.error(`Error playing track "${songTitle}":`, err);
    consecutiveSkipCount++;
    if (consecutiveSkipCount >= 3) {
      console.log('3 tracks errored in a row. Resetting YouTube session and pausing 30s before retrying...');
      resetInnertube();
      isPlayingMusic = false;
      consecutiveSkipCount = 0;
      setTimeout(() => playNextSong(activeMusicTextChannel), 30000);
      return;
    }
    setTimeout(() => playNextSong(activeMusicTextChannel), 3000);
  } finally {
    isLoadingSong = false;
  }
}

musicPlayer.on(AudioPlayerStatus.Idle, () => {
  isPlayingMusic = false;
  if (isPlayingErrorTTS) {
    // TTS just finished — don't immediately call playNextSong (prevents infinite loop)
    isPlayingErrorTTS = false;
    console.log('TTS error message finished. Waiting 10s before retrying playback...');
    setTimeout(() => playNextSong(activeMusicTextChannel), 10000);
    return;
  }
  playNextSong(activeMusicTextChannel);
});

musicPlayer.on('error', error => {
  // Log the whole error (message + resource context) — this is where a Render
  // stream failure shows up. A bare error.message can hide the real cause.
  console.error('AudioPlayer error:', error && error.message ? error.message : error);
  if (error && error.resource) {
    console.error('  error.resource present; playbackDuration=', error.resource.playbackDuration);
  }
  isPlayingMusic = false;
  // Don't call playAudioErrorMessage here — it plays on the same player
  // and triggers Idle → playNextSong → fail → error → TTS loop.
  // The Idle event will fire automatically and retry.
});

// Log real playback starts so the Render logs distinguish "stream resolved and
// audio is flowing" from "resolved but never actually played."
musicPlayer.on(AudioPlayerStatus.Playing, () => {
  console.log('▶️ AudioPlayer is now Playing (audio should be audible).');
});
musicPlayer.on(AudioPlayerStatus.Buffering, () => {
  console.log('⏳ AudioPlayer buffering...');
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

// 24/7 Voice playback and auto-reconnect logic
const playInVoice = async (vc, textChannel = null) => {
  isExplicitlyDisconnected = false;
  if (textChannel) activeMusicTextChannel = textChannel;
  if (currentVoiceConnection) {
    try { currentVoiceConnection.destroy(); } catch {}
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
    if (isExplicitlyDisconnected) return;
    console.log('Voice connection lost. Attempting to recover...');
    try {
      await Promise.race([
        entersState(currentVoiceConnection, VoiceConnectionStatus.Signalling, 5000),
        entersState(currentVoiceConnection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      if (!isExplicitlyDisconnected && currentVoiceChannel) {
        console.log('Voice connection lost. Auto-reconnecting in 3s to keep 24/7 music running...');
        setTimeout(() => {
          if (!isExplicitlyDisconnected && currentVoiceChannel) {
            playInVoice(currentVoiceChannel, activeMusicTextChannel);
          }
        }, 3000);
      }
    }
  });

  try {
    await entersState(currentVoiceConnection, VoiceConnectionStatus.Ready, 15000);
    console.log(`Voice connection ready in ${vc.name}`);
  } catch (err) {
    console.error('Voice connection failed to reach Ready status in 15s:', err.message);
  }

  if (!isPlayingMusic) {
    if (musicQueue.length === 0) {
      await loadPlaylist();
    }
    playNextSong(activeMusicTextChannel);
  }
};

client.once('ready', async () => {
  console.log(`Greeter bot logged in as ${client.user.tag}`);

  // Startup self-test: prove the pieces the music pipeline depends on actually
  // work in THIS environment (Render vs local differ). Runs once, logs clearly,
  // and never blocks startup. If music is silent later, these lines say whether
  // FFmpeg, the YouTube session, or stream extraction is the broken link.
  (async () => {
    try {
      const { execFile } = require('child_process');
      const ff = require('ffmpeg-static');
      await new Promise((resolve) => {
        execFile(ff, ['-version'], { timeout: 5000 }, (err) => {
          console.log(err ? `[selftest] FFmpeg NOT runnable: ${err.message}` : '[selftest] FFmpeg OK');
          resolve();
        });
      });
    } catch (e) {
      console.log(`[selftest] FFmpeg check threw: ${e.message}`);
    }
    try {
      const yt = await getInnertube();
      const info = await yt.getBasicInfo('kIft-LUHHVA').catch(e => { throw e; });
      console.log(`[selftest] YouTube session OK (title: ${info.basic_info && info.basic_info.title})`);
    } catch (e) {
      console.log(`[selftest] YouTube session FAILED: ${e.message}`);
    }
  })();

  // Set the bot's Discord presence / status
  client.user.setPresence({
    activities: [{ name: 'HCPSS Status', type: ActivityType.Watching }],
    status: 'online',
  });

  // Auto-connect to configured 24/7 VC on startup or deployment restart.
  // Gated by MUSIC_ENABLED so the voice runtime stays dormant while music is
  // disabled in the panel; all playback code below is preserved.
  if (MUSIC_ENABLED) {
    // The guild cache can still be empty the instant 'ready' fires (a Render
    // cold start), which would skip the auto-join entirely. Retry a few times
    // until the cache fills, then attempt the join once.
    const attemptAutoJoin = async () => {
      try {
        for (const [guildId, guild] of client.guilds.cache) {
          const config = await getGuildConfig(guildId);
          if (config && config.music_vc_id) {
            const vc = await guild.channels.fetch(config.music_vc_id).catch(() => null);
            if (vc) {
              console.log(`[Auto-Join 24/7] Connecting to configured VC: ${vc.name} (${vc.id})`);
              let txt = null;
              if (config.music_channel_id) {
                txt = await guild.channels.fetch(config.music_channel_id).catch(() => null);
              }
              await playInVoice(vc, txt);
              return true;
            }
          }
        }
      } catch (err) {
        console.error('Error auto-joining 24/7 VC on startup:', err);
      }
      return false;
    };

    (async () => {
      for (let i = 0; i < 5; i++) {
        if (client.guilds.cache.size > 0) {
          if (await attemptAutoJoin()) return;
          break; // cache was ready but no VC configured — nothing to retry
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      if (client.guilds.cache.size === 0) {
        console.log('[Auto-Join 24/7] Guild cache still empty after retries; will join on next Join press.');
      }
    })();
  }
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

// Keep bot playing 24/7; do not disconnect when users leave VC
client.on('voiceStateUpdate', async (oldState, newState) => {
  // Voice state logging or no-op; bot remains connected and playing
});


client.on('messageCreate', async (message) => {
  if (message.content === '!greeter-ping') {
    await message.channel.send('Pong! The greeter bot is alive and reading messages.');
    return;
  }


  // Keyword auto-reply: staff configure rules on the control panel's Auto-Reply
  // tab. Each rule targets one channel with its own keywords and reply. When a
  // user sends one of a rule's keywords in that channel, the bot responds with
  // the rule's message.
  //
  // Discord cannot send a true ephemeral ("only you can see this") from a
  // messageCreate event — that flag only works as a reply to an interaction.
  // The closest real equivalent is a DM: private to that user, no channel
  // clutter, nothing to delete. If their DMs are closed we fall back to a brief
  // in-channel reply that auto-deletes.
  if (message.guild && !message.author.bot) {
    const config = await getGuildConfig(message.guild.id);
    if (config) {
      const text = (message.content || '').toLowerCase();

      // Build the effective rule list: the staff-managed rules plus the legacy
      // single-channel rule (kept so older configs keep working).
      const rules = [];
      if (Array.isArray(config.keyword_rules)) {
        for (const r of config.keyword_rules) {
          if (r && r.channel_id === message.channel.id && Array.isArray(r.keywords)) {
            rules.push({ keywords: r.keywords, response: r.response });
          }
        }
      }
      if (config.keyword_channel_id && config.keyword_channel_id === message.channel.id) {
        rules.push({
          keywords: ['mod abuse', 'staff abuse'],
          response: 'If you would like to report a staff member, you can open a ticket to report the user.'
        });
      }

      for (const rule of rules) {
        const hit = rule.keywords.some(k => k && text.includes(String(k).toLowerCase()));
        if (!hit) continue;
        const replyText = rule.response ||
          'If you would like to report a staff member, you can open a ticket to report the user.';

        // Try a private DM first (the ephemeral-like behavior).
        const dmOk = await message.author.send(replyText).then(() => true).catch(() => false);
        if (!dmOk) {
          // DMs closed: fall back to a short in-channel reply that self-deletes.
          const reply = await message.reply({ content: replyText, allowedMentions: { repliedUser: false } })
            .catch(() => null);
          if (reply) setTimeout(() => reply.delete().catch(() => {}), 8000);
        }
        break; // one reply per message is enough
      }
    }
  }


  // Handle music channel message deletions and verification.
  // Gated by MUSIC_ENABLED so this stays dormant while music is disabled.
  if (MUSIC_ENABLED && message.guild) {
    const config = await getGuildConfig(message.guild.id);
    if (config && config.music_channel_id && message.channel.id === config.music_channel_id) {
      // 1. Delete message after 5 seconds (except control panel embeds)
      if (message.content.startsWith('GREET_BOT_COMMAND:')) {
        message.delete().catch(() => {});
      } else if (message.author.id !== client.user.id) {
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
  // Gated by MUSIC_ENABLED: these are the music/voice control commands. While
  // music is disabled the trigger messages are simply ignored (code preserved).
  if (MUSIC_ENABLED && message.content.startsWith('GREET_BOT_COMMAND:')) {
    const content = message.content.trim();
    // Delete the trigger message right away if possible
    message.delete().catch(() => {});

    // Fallback for DMs
    const guild = message.guild || client.guilds.cache.first();
    if (!guild) {
      console.log('No guild available to execute GREET_BOT_COMMAND');
      return;
    }

    if (content.startsWith('GREET_BOT_COMMAND: JOIN') || content.startsWith('GREET_BOT_COMMAND: TOGGLE_VOICE')) {
      if (emergencyMode) { emergencyMode = false; console.log('Emergency mode cleared by JOIN command.'); }
      const parts = content.split(' ');
      const userId = parts[2];
      const fallbackChannelId = parts[3];

      let targetVc = null;
      if (userId && userId !== 'LEAVE') {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member && member.voice && member.voice.channel) {
          targetVc = member.voice.channel;
        }
      }
      if (!targetVc && fallbackChannelId && fallbackChannelId !== 'LEAVE') {
        targetVc = await guild.channels.fetch(fallbackChannelId).catch(() => null);
      }
      if (!targetVc && userId && userId !== 'LEAVE') {
        // userId might actually be a channel ID (from TOGGLE_VOICE)
        targetVc = await guild.channels.fetch(userId).catch(() => null);
      }

      // Check if LEAVE command or toggle off
      if (userId === 'LEAVE' || fallbackChannelId === 'LEAVE') {
        isExplicitlyDisconnected = true;
        if (currentVoiceConnection) {
          // stop(true) forces the player to Idle and destroys the resource, so
          // the shared player is left in a clean state for the next join. A bare
          // pause() would strand it in Paused and mute every future track.
          try { musicPlayer.stop(true); } catch {}
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
        isExplicitlyDisconnected = true;
        // Force the player to Idle (see LEAVE above) so it isn't left Paused.
        try { musicPlayer.stop(true); } catch {}
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
      if (emergencyMode) { emergencyMode = false; console.log('Emergency mode cleared by PLAY_NORMAL command.'); }
      const parts = content.split(' ');
      const userId = parts[2];

      const config = await getGuildConfig(guild.id);
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
          const member = await guild.members.fetch(userId).catch(() => null);
          if (member && member.voice && member.voice.channel) {
            targetVc = member.voice.channel;
          }
        }
        if (!targetVc && config && config.music_vc_id) {
          targetVc = await guild.channels.fetch(config.music_vc_id).catch(() => null);
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
      const prefix = 'GREET_BOT_COMMAND: PLAY_SONG ';
      const rest = content.slice(prefix.length).trim();
      const lastSpaceIdx = rest.lastIndexOf(' ');
      let songUrl = rest;
      let userId = null;
      if (lastSpaceIdx !== -1) {
        const possibleUser = rest.slice(lastSpaceIdx + 1).trim();
        if (/^\d{17,20}$/.test(possibleUser)) {
          songUrl = rest.slice(0, lastSpaceIdx).trim();
          userId = possibleUser;
        }
      }

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
          const config = await getGuildConfig(guild.id);
          let targetVc = null;
          if (userId) {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member && member.voice && member.voice.channel) {
              targetVc = member.voice.channel;
            }
          }
          if (!targetVc && config && config.music_vc_id) {
            targetVc = await guild.channels.fetch(config.music_vc_id).catch(() => null);
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

    if (content.startsWith('GREET_BOT_COMMAND: SKIP')) {
      if (!currentVoiceConnection) {
        const config = await getGuildConfig(guild.id);
        let targetVc = null;
        if (config && config.music_vc_id) {
          targetVc = await guild.channels.fetch(config.music_vc_id).catch(() => null);
        }
        if (targetVc) {
          await playInVoice(targetVc, message.channel);
        }
      } else {
        if (musicPlayer.state.status === AudioPlayerStatus.Idle) {
          playNextSong(message.channel);
        } else {
          // stop(true) forces an immediate Idle transition. A bare stop() waits
          // for the resource's silence-padding frames to drain, and if the
          // player was paused those frames never play — so Idle (and the
          // follow-up playNextSong) would never fire and playback would die.
          musicPlayer.stop(true); // -> Idle event -> playNextSong
        }
      }
      const m = await message.channel.send('⏭️ Skipped current track.').catch(() => null);
      if (m) setTimeout(() => m.delete().catch(() => {}), 5000);
      return;
    }

    if (content.startsWith('GREET_BOT_COMMAND: PAUSE')) {
      if (currentVoiceConnection) {
        musicPlayer.pause();
        isPlayingMusic = false;
        const m = await message.channel.send('⏸️ Paused playback.').catch(() => null);
        if (m) setTimeout(() => m.delete().catch(() => {}), 5000);
      }
      return;
    }

    if (content.startsWith('GREET_BOT_COMMAND: RESUME')) {
      if (emergencyMode) { emergencyMode = false; console.log('Emergency mode cleared by RESUME command.'); }
      if (!currentVoiceConnection) {
        const config = await getGuildConfig(guild.id);
        let targetVc = null;
        if (config && config.music_vc_id) {
          targetVc = await guild.channels.fetch(config.music_vc_id).catch(() => null);
        }
        if (targetVc) {
          await playInVoice(targetVc, message.channel);
        }
      } else {
        if (musicPlayer.state.status === AudioPlayerStatus.Paused) {
          musicPlayer.unpause();
          isPlayingMusic = true;
        } else if (musicPlayer.state.status === AudioPlayerStatus.Idle) {
          playNextSong(message.channel);
        }
      }
      const m = await message.channel.send('▶️ Resumed playback.').catch(() => null);
      if (m) setTimeout(() => m.delete().catch(() => {}), 5000);
      return;
    }

    if (content.startsWith('GREET_BOT_COMMAND: EMERGENCY_LEAVE')) {
      console.log('🚨 EMERGENCY LEAVE activated — shutting down music, VC, and greetings.');
      emergencyMode = true;
      isExplicitlyDisconnected = true;

      // Stop music
      try { musicPlayer.stop(true); } catch {}
      isPlayingMusic = false;
      musicQueue = [];

      // Leave VC
      if (currentVoiceConnection) {
        try { currentVoiceConnection.destroy(); } catch {}
        currentVoiceConnection = null;
        currentVoiceChannel = null;
      }

      const m = await message.channel.send('🚨 **Emergency shutdown activated.** Music stopped, VC left, greetings disabled. HCPSS status checking is still running.').catch(() => null);
      if (m) setTimeout(() => m.delete().catch(() => {}), 30000);
      return;
    }
  }
});

client.on('guildMemberAdd', async (member) => {
  if (emergencyMode) {
    console.log(`🚨 Emergency mode: skipping greeting for ${member.user.tag}`);
    return;
  }
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
