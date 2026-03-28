// worker.js — All CPU-heavy work runs here, off the main UI thread.
// Communicates via postMessage with { type, payload } protocol.

// ── Supported formats ────────────────────────────────────────────────────────
const AUDIO_EXTS = new Set([
  'mp3','flac','aac','wav','ogg','m4a','wma','aiff','aif',
  'opus','ape','wv','mpc','mp4','m4b','m4p','oga','spx','tta','dsf'
]);

// ── Utilities ────────────────────────────────────────────────────────────────

function emit(type, payload) {
  self.postMessage({ type, payload });
}

function progress(stage, current, total, message) {
  emit('progress', { stage, current, total, pct: total ? Math.round(current/total*100) : 0, message });
}

// FNV-1a 64-bit hash in JS (two 32-bit halves, hex-concatenated)
// Fast enough for multi-MB files; no WASM dependency required.
function fnv1aHash(bytes) {
  let h0 = 0x811c9dc5 >>> 0;
  let h1 = 0x00000000 >>> 0;
  const FNV_PRIME_LO = 0x01000193 >>> 0;

  for (let i = 0; i < bytes.length; i++) {
    h0 ^= bytes[i];
    // 32-bit multiply with carry into h1
    const lo = Math.imul(h0, FNV_PRIME_LO) >>> 0;
    const hi = (Math.imul(h1, FNV_PRIME_LO) + Math.imul(h0, 0x0100)) >>> 0;
    h0 = lo;
    h1 = hi;
  }
  return (h1 >>> 0).toString(16).padStart(8,'0') + (h0 >>> 0).toString(16).padStart(8,'0');
}

async function hashFile(file) {
  try {
    // Use SubtleCrypto SHA-1 — browser-native, very fast
    const buf = await file.arrayBuffer();
    const hashBuf = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
  } catch {
    return null;
  }
}

async function hashAudioPayload(file, ext) {
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let offset = 0;

    // Skip ID3v2 header for MP3
    if (ext === 'mp3' && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) |
                   ((bytes[8] & 0x7f) << 7)  |  (bytes[9] & 0x7f);
      offset = 10 + size;
    }
    // Skip fLaC metadata blocks
    else if (ext === 'flac' && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
      offset = 4;
      while (offset + 4 < bytes.length) {
        const isLast = (bytes[offset] & 0x80) !== 0;
        const blockLen = (bytes[offset+1] << 16) | (bytes[offset+2] << 8) | bytes[offset+3];
        offset += 4 + blockLen;
        if (isLast) break;
      }
    }

    const audioBytes = offset > 0 ? bytes.slice(offset) : bytes;
    const hashBuf = await crypto.subtle.digest('SHA-1', audioBytes);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
  } catch {
    return null;
  }
}

// ── Metadata parsing (pure JS, no mutagen) ───────────────────────────────────

async function extractMetadata(file, ext) {
  const meta = { title: null, artist: null, album: null, year: null, track: null,
                 duration: null, bitrate: null, sampleRate: null, channels: null };
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    if (ext === 'mp3') await parseMp3(bytes, meta, file.size);
    else if (ext === 'flac') await parseFlac(bytes, meta);
    else if (['m4a','mp4','m4b','aac'].includes(ext)) await parseMp4(bytes, meta);
    else if (['ogg','oga','opus'].includes(ext)) await parseOgg(bytes, meta);
  } catch {}
  return meta;
}

function readU32BE(b, o) { return ((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3]) >>> 0; }
function readU32LE(b, o) { return ((b[o+3]<<24)|(b[o+2]<<16)|(b[o+1]<<8)|b[o]) >>> 0; }
function readU16BE(b, o) { return (b[o]<<8)|b[o+1]; }
function utf8(b, s, e) { try { return new TextDecoder().decode(b.slice(s,e)).replace(/\0.*$/,'').trim(); } catch { return null; } }
function latin1(b, s, e) { return Array.from(b.slice(s,e)).map(c=>String.fromCharCode(c)).join('').replace(/\0.*$/,'').trim(); }

async function parseMp3(bytes, meta, fileSize) {
  let offset = 0;
  // ID3v2
  if (bytes[0]===0x49 && bytes[1]===0x44 && bytes[2]===0x33) {
    const ver = bytes[3];
    const tagSize = ((bytes[6]&0x7f)<<21)|((bytes[7]&0x7f)<<14)|((bytes[8]&0x7f)<<7)|(bytes[9]&0x7f);
    offset = 10;
    const tagEnd = 10 + tagSize;
    while (offset + 10 < tagEnd) {
      const fid = latin1(bytes, offset, offset+4);
      const fsize = ver >= 4
        ? ((bytes[offset+4]&0x7f)<<21)|((bytes[offset+5]&0x7f)<<14)|((bytes[offset+6]&0x7f)<<7)|(bytes[offset+7]&0x7f)
        : readU32BE(bytes, offset+4);
      const fstart = offset + 10;
      if (fsize <= 0 || fsize > 1000000) break;
      const enc = bytes[fstart];
      const str = (enc===1||enc===2)
        ? new TextDecoder('utf-16').decode(bytes.slice(fstart+1, fstart+fsize)).replace(/\0.*$/,'').trim()
        : utf8(bytes, fstart+1, fstart+fsize);
      if (fid==='TIT2') meta.title = str;
      else if (fid==='TPE1') meta.artist = str;
      else if (fid==='TALB') meta.album = str;
      else if (fid==='TDRC'||fid==='TYER') meta.year = str?.substring(0,4);
      else if (fid==='TRCK') meta.track = str;
      offset = fstart + fsize;
    }
  }
  // ID3v1 fallback
  if (bytes.length >= 128 && bytes[bytes.length-128]===0x54 && bytes[bytes.length-127]===0x41 && bytes[bytes.length-126]===0x47) {
    const b = bytes, e = bytes.length;
    if (!meta.title)  meta.title  = latin1(b, e-125, e-95).trim() || null;
    if (!meta.artist) meta.artist = latin1(b, e-95,  e-65).trim() || null;
    if (!meta.album)  meta.album  = latin1(b, e-65,  e-35).trim() || null;
    if (!meta.year)   meta.year   = latin1(b, e-35,  e-31).trim() || null;
  }
  // Estimate bitrate from file size + rough frame scan
  try {
    // Find first sync frame
    for (let i = offset; i < Math.min(bytes.length - 4, offset + 32768); i++) {
      if (bytes[i]===0xff && (bytes[i+1]&0xe0)===0xe0) {
        const h = (bytes[i]<<24)|(bytes[i+1]<<16)|(bytes[i+2]<<8)|bytes[i+3];
        const brIdx = (h>>12)&0xf, srIdx = (h>>10)&0x3, layer = 4-((h>>17)&0x3);
        const BITRATES = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
        const SAMPLERATES = [44100,48000,32000,0];
        if (brIdx>0 && brIdx<15 && srIdx<3) {
          meta.bitrate = BITRATES[brIdx];
          meta.sampleRate = SAMPLERATES[srIdx];
          meta.channels = ((h>>6)&0x3)===3 ? 1 : 2;
          // Duration estimate
          const samplesPerFrame = layer===1 ? 384 : 1152;
          if (meta.bitrate && meta.sampleRate) {
            meta.duration = (fileSize * 8) / (meta.bitrate * 1000);
          }
          break;
        }
      }
    }
  } catch {}
}

function parseVorbisComment(bytes, offset, meta) {
  const vendorLen = readU32LE(bytes, offset); offset += 4 + vendorLen;
  const count = readU32LE(bytes, offset); offset += 4;
  for (let i = 0; i < count && offset < bytes.length; i++) {
    const len = readU32LE(bytes, offset); offset += 4;
    const comment = utf8(bytes, offset, offset+len) || '';
    offset += len;
    const eq = comment.indexOf('=');
    if (eq < 0) continue;
    const key = comment.substring(0,eq).toUpperCase();
    const val = comment.substring(eq+1).trim();
    if (key==='TITLE') meta.title = val;
    else if (key==='ARTIST') meta.artist = val;
    else if (key==='ALBUM') meta.album = val;
    else if (key==='DATE'||key==='YEAR') meta.year = val.substring(0,4);
    else if (key==='TRACKNUMBER') meta.track = val;
  }
}

async function parseFlac(bytes, meta) {
  if (bytes[0]!==0x66) return; // 'f'
  let offset = 4;
  while (offset + 4 < bytes.length) {
    const isLast = (bytes[offset] & 0x80) !== 0;
    const type   = bytes[offset] & 0x7f;
    const blen   = (bytes[offset+1]<<16)|(bytes[offset+2]<<8)|bytes[offset+3];
    offset += 4;
    if (type === 0) { // STREAMINFO
      meta.sampleRate = ((bytes[offset]<<12)|(bytes[offset+1]<<4)|(bytes[offset+2]>>4)) & 0xFFFFF;
      meta.channels = ((bytes[offset+2]>>1) & 0x7) + 1;
      const totalSamples = ((bytes[offset+13] & 0xf) * 0x100000000) +
        ((bytes[offset+14]<<24)|(bytes[offset+15]<<16)|(bytes[offset+16]<<8)|bytes[offset+17]);
      if (meta.sampleRate) meta.duration = totalSamples / meta.sampleRate;
    } else if (type === 4) { // VORBIS_COMMENT
      parseVorbisComment(bytes, offset, meta);
    }
    offset += blen;
    if (isLast) break;
  }
}

async function parseMp4(bytes, meta) {
  function readBox(b, start, end) {
    const boxes = [];
    let o = start;
    while (o + 8 <= end) {
      let size = readU32BE(b, o);
      const name = latin1(b, o+4, o+8);
      let headerSize = 8;
      if (size === 1) { size = Number(new DataView(b.buffer).getBigUint64(o+8)); headerSize = 16; }
      if (size < headerSize) break;
      boxes.push({ name, start: o+headerSize, end: o+size, size });
      o += size;
    }
    return boxes;
  }
  function find(boxes, ...names) {
    for (const b of boxes) { if (names.includes(b.name)) return b; }
    return null;
  }
  function dig(b, start, end, ...path) {
    let boxes = readBox(b, start, end);
    for (let i = 0; i < path.length - 1; i++) {
      const found = find(boxes, path[i]);
      if (!found) return null;
      boxes = readBox(b, found.start, found.end);
    }
    return find(boxes, path[path.length-1]);
  }

  const top = readBox(bytes, 0, bytes.length);
  const moov = find(top, 'moov');
  if (!moov) return;

  // ilst tags
  const ilst = dig(bytes, moov.start, moov.end, 'udta', 'meta', 'ilst') ||
               dig(bytes, moov.start, moov.end, 'meta', 'ilst');
  if (ilst) {
    const items = readBox(bytes, ilst.start, ilst.end);
    for (const item of items) {
      const data = find(readBox(bytes, item.start, item.end), 'data');
      if (!data || data.size < 12) continue;
      const val = utf8(bytes, data.start+8, data.end)?.trim();
      if (!val) continue;
      if (item.name==='\xa9nam') meta.title = val;
      else if (item.name==='\xa9ART') meta.artist = val;
      else if (item.name==='\xa9alb') meta.album = val;
      else if (item.name==='\xa9day') meta.year = val.substring(0,4);
      else if (item.name==='trkn') meta.track = String(new DataView(bytes.buffer).getUint16(data.start+10));
    }
  }

  // Duration from mvhd
  const mvhd = dig(bytes, moov.start, moov.end, 'mvhd');
  if (mvhd) {
    const ver = bytes[mvhd.start];
    const dv = new DataView(bytes.buffer);
    if (ver === 1) {
      const timescale = dv.getUint32(mvhd.start + 20);
      const duration = Number(dv.getBigUint64(mvhd.start + 24));
      if (timescale) meta.duration = duration / timescale;
    } else {
      const timescale = dv.getUint32(mvhd.start + 12);
      const duration = dv.getUint32(mvhd.start + 16);
      if (timescale) meta.duration = duration / timescale;
    }
  }
}

async function parseOgg(bytes, meta) {
  // Find vorbis comment header (page type 3)
  for (let i = 0; i + 27 < bytes.length; i++) {
    if (bytes[i]!==0x4f||bytes[i+1]!==0x67||bytes[i+2]!==0x67||bytes[i+3]!==0x53) continue;
    // Ogg page: find segment data
    const nseg = bytes[i+26];
    let dataStart = i + 27 + nseg;
    // Check for vorbis comment packet (type 0x03) or opus tags (OpusTags)
    if (dataStart + 7 < bytes.length) {
      if ((bytes[dataStart]===3 && bytes[dataStart+1]===0x76) || // vorbis
          (bytes[dataStart]===0x4f && bytes[dataStart+5]===0x54)) { // OpusTags
        const vcOffset = bytes[dataStart]===3 ? dataStart+7 : dataStart+8;
        parseVorbisComment(bytes, vcOffset, meta);
        return;
      }
    }
  }
}

// ── Format ranking for "keep" recommendation ─────────────────────────────────
const FORMAT_RANK = { flac:10, wav:9, aiff:9, aif:9, m4a:7, mp3:6, ogg:5, opus:5, aac:4, wma:3 };

function pickBest(files) {
  return files.reduce((best, f) => {
    const bScore = (FORMAT_RANK[best.ext]||0)*1000 + (best.bitrate||0);
    const fScore = (FORMAT_RANK[f.ext]||0)*1000 + (f.bitrate||0);
    return fScore > bScore ? f : best;
  });
}

// ── Main scan logic ──────────────────────────────────────────────────────────

async function runScan({ fileHandles }) {
  const files = [];

  // ── Phase 1: Build file list ──────────────────────────────────────────────
  progress('building', 0, fileHandles.length, `Indexing ${fileHandles.length} files…`);

  for (let i = 0; i < fileHandles.length; i++) {
    const h = fileHandles[i];
    try {
      const file = await h.getFile();
      const nameParts = file.name.split('.');
      const ext = nameParts.length > 1 ? nameParts.pop().toLowerCase() : '';
      if (!AUDIO_EXTS.has(ext)) continue;

      files.push({
        id: i,
        handle: h,
        file,
        name: file.name,
        ext,
        size: file.size,
        path: h.name,          // name is all we reliably get from FSAPI
        fileHash: null,
        audioHash: null,
        meta: {},
        corrupt: false,
        errorMsg: null,
      });
    } catch (e) {
      // permission error or other — skip
    }
    if (i % 100 === 0) progress('building', i, fileHandles.length, `Indexing ${i}/${fileHandles.length}…`);
  }

  emit('stats', { totalAudio: files.length });

  // ── Phase 2: Metadata extraction ─────────────────────────────────────────
  for (let i = 0; i < files.length; i++) {
    const af = files[i];
    try {
      af.meta = await extractMetadata(af.file, af.ext);
    } catch (e) {
      af.corrupt = true;
      af.errorMsg = String(e);
    }
    if (i % 50 === 0 || i === files.length-1) {
      progress('metadata', i+1, files.length, `Reading metadata ${i+1}/${files.length}: ${af.name}`);
    }
  }

  // ── Phase 3: File hashing ─────────────────────────────────────────────────
  const BATCH = 20;
  for (let i = 0; i < files.length; i++) {
    const af = files[i];
    if (af.corrupt) continue;
    try {
      af.fileHash = await hashFile(af.file);
      af.audioHash = await hashAudioPayload(af.file, af.ext);
    } catch (e) {
      af.corrupt = true; af.errorMsg = String(e);
    }
    if (i % BATCH === 0 || i === files.length-1) {
      progress('hashing', i+1, files.length, `Hashing ${i+1}/${files.length}: ${af.name}`);
    }
  }

  // ── Phase 4: Duplicate detection ─────────────────────────────────────────
  progress('detecting', 0, 1, 'Detecting duplicates…');
  const groups = [];
  const grouped = new Set();

  // Stage 1 — exact file hash
  const byFileHash = new Map();
  for (const af of files) {
    if (af.corrupt || !af.fileHash) continue;
    if (!byFileHash.has(af.fileHash)) byFileHash.set(af.fileHash, []);
    byFileHash.get(af.fileHash).push(af);
  }
  for (const [, grpFiles] of byFileHash) {
    if (grpFiles.length < 2) continue;
    const best = pickBest(grpFiles);
    groups.push({ type: 'exact_file', typeLabel: 'Exact Copy', color: '#ef4444', files: grpFiles, keep: best.name });
    grpFiles.forEach(f => grouped.add(f.id));
  }

  // Stage 2 — audio payload hash
  const byAudioHash = new Map();
  for (const af of files) {
    if (af.corrupt || grouped.has(af.id) || !af.audioHash) continue;
    if (!byAudioHash.has(af.audioHash)) byAudioHash.set(af.audioHash, []);
    byAudioHash.get(af.audioHash).push(af);
  }
  for (const [, grpFiles] of byAudioHash) {
    if (grpFiles.length < 2) continue;
    const best = pickBest(grpFiles);
    groups.push({ type: 'exact_audio', typeLabel: 'Same Audio', color: '#f97316', files: grpFiles, keep: best.name });
    grpFiles.forEach(f => grouped.add(f.id));
  }

  // Stage 3 — metadata (title+artist)
  const byMeta = new Map();
  for (const af of files) {
    if (af.corrupt || grouped.has(af.id)) continue;
    const t = (af.meta.title||'').trim().toLowerCase();
    const a = (af.meta.artist||'').trim().toLowerCase();
    if (!t || !a) continue;
    const key = `${a}|||${t}`;
    if (!byMeta.has(key)) byMeta.set(key, []);
    byMeta.get(key).push(af);
  }
  for (const [, grpFiles] of byMeta) {
    if (grpFiles.length < 2) continue;
    const best = pickBest(grpFiles);
    groups.push({ type: 'metadata_match', typeLabel: 'Metadata Match', color: '#eab308', files: grpFiles, keep: best.name });
    grpFiles.forEach(f => grouped.add(f.id));
  }

  const corrupt = files.filter(f => f.corrupt);

  // Serialize — FileSystemFileHandle is not transferable, strip it
  const serializeFile = af => ({
    id: af.id,
    name: af.name,
    ext: af.ext,
    size: af.size,
    sizeMB: (af.size/1048576).toFixed(2),
    fileHash: af.fileHash,
    title: af.meta.title,
    artist: af.meta.artist,
    album: af.meta.album,
    year: af.meta.year,
    track: af.meta.track,
    duration: af.meta.duration,
    durationStr: af.meta.duration ? `${Math.floor(af.meta.duration/60)}:${String(Math.floor(af.meta.duration%60)).padStart(2,'0')}` : null,
    bitrate: af.meta.bitrate,
    sampleRate: af.meta.sampleRate,
    corrupt: af.corrupt,
    errorMsg: af.errorMsg,
  });

  const serialGroups = groups.map((g, idx) => ({
    id: `g${idx}`,
    type: g.type,
    typeLabel: g.typeLabel,
    color: g.color,
    keep: g.keep,
    files: g.files.map(serializeFile),
    wastedBytes: g.files.filter(f=>f.name!==g.keep).reduce((s,f)=>s+f.size,0),
  }));

  const totalWasted = serialGroups.reduce((s,g)=>s+g.wastedBytes,0);
  const removableCount = serialGroups.reduce((s,g)=>s+g.files.length-1,0);

  emit('done', {
    groups: serialGroups,
    allFiles: files.map(serializeFile),
    corrupt: corrupt.map(serializeFile),
    totalFiles: files.length,
    totalWastedMB: (totalWasted/1048576).toFixed(1),
    removableCount,
  });
}

// ── Message router ────────────────────────────────────────────────────────────
self.onmessage = async ({ data }) => {
  if (data.type === 'scan') {
    try {
      await runScan(data.payload);
    } catch (e) {
      emit('error', { message: e.message || String(e) });
    }
  }
};
