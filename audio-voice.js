// audio-voice.js — Âm thanh & giọng nói của MTD
//  - SoundEngine: tổng hợp nhạc chiptune, tiếng mưa, hộp nhạc, hiệu ứng bíp bằng Web Audio API.
//  - Voice: đọc tiếng Việt bằng SpeechSynthesis (chia câu để tránh lỗi bị cắt giữa chừng của Chrome).
//  - Listener: nghe liên tục bằng SpeechRecognition, tự khởi động lại khi bị ngắt.

// ======================================================================
// NỐT NHẠC
// ======================================================================

const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "A4" -> 440 Hz, "C#5" -> 554.37 Hz. "R" là nốt lặng (trả về 0). */
export function noteToFreq(note) {
  const m = /^([A-G])(#|b)?(\d)$/.exec(note);
  if (!m) return 0;
  let semitone = SEMITONES[m[1]];
  if (m[2] === "#") semitone += 1;
  if (m[2] === "b") semitone -= 1;
  const midi = (Number(m[3]) + 1) * 12 + semitone;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Lấy đúng `count` nốt từ chuỗi nốt: thiếu thì lặp lại, thừa thì cắt bớt. */
export function fitNotes(noteString, count) {
  const notes = noteString.trim().split(/\s+/);
  return Array.from({ length: count }, (_, i) => notes[i % notes.length]);
}

const LULLABY = "E5 G5 C6 B5 G5 E5 F5 A5 D6 C6 A5 F5 E5 G5 C6 E6 D6 C6 B5 G5 A5 B5 C6 R".split(" ");

// ======================================================================
// SOUND ENGINE
// ======================================================================

export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicNodes = [];
    this.musicTimer = null;
    this.musicResolve = null;
    this.ambient = null; // { gain, nodes, timers }
  }

  /** Phải gọi trong một sự kiện click/phím của người dùng để trình duyệt cho phép phát âm thanh. */
  unlock() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  get ready() {
    return Boolean(this.ctx);
  }

  /** Phát một nốt có bao âm (envelope) để tiếng không bị "bụp". */
  tone(freq, start, duration, { type = "square", volume = 0.08, dest = this.master, release = 0.05 } = {}) {
    if (!this.ctx || !freq) return null;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
    gain.gain.setValueAtTime(volume, Math.max(start + 0.02, start + duration - release));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain).connect(dest);
    osc.start(start);
    osc.stop(start + duration + 0.05);
    return osc;
  }

  /** Các tiếng bíp hiệu ứng. */
  bleep(kind = "hello") {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.02;
    const seq = {
      boot: [["C5", 0.08], ["E5", 0.08], ["G5", 0.08], ["C6", 0.22]],
      hello: [["G5", 0.09], ["C6", 0.16]],
      wake: [["E5", 0.07], ["G5", 0.07], ["E6", 0.18]],
      heart: [["A5", 0.1], ["E6", 0.2]],
    }[kind];
    if (kind === "calc") {
      for (let i = 0; i < 8; i++) this.tone(900 + Math.random() * 900, t + i * 0.06, 0.04, { volume: 0.04 });
      return;
    }
    let offset = 0;
    for (const [note, dur] of seq || []) {
      this.tone(noteToFreq(note), t + offset, dur, { volume: 0.06 });
      offset += dur;
    }
  }

  /**
   * Phát một câu nhạc: mỗi nốt dài 1 phách, nốt cuối ngân 2 phách.
   * Kèm một nốt bass tam giác giữ suốt câu. Trả về Promise kết thúc khi phát xong (hoặc bị dừng).
   */
  playLine(notes, beatSeconds, { melodyVolume = 0.05, melodyType = "square" } = {}) {
    if (!this.ctx) return Promise.resolve();
    this.stopMusic();
    const start = this.ctx.currentTime + 0.05;
    let t = start;
    notes.forEach((note, i) => {
      const dur = i === notes.length - 1 ? beatSeconds * 2 : beatSeconds;
      const osc = this.tone(noteToFreq(note), t, dur * 0.92, { type: melodyType, volume: melodyVolume });
      if (osc) this.musicNodes.push(osc);
      t += dur;
    });
    const total = t - start;
    // Bass: nốt đầu câu hạ 2 quãng tám.
    const bassFreq = noteToFreq(notes[0]) / 4;
    const bass = this.tone(bassFreq, start, total, { type: "triangle", volume: 0.09, release: 0.3 });
    if (bass) this.musicNodes.push(bass);
    // Tiếng "tách" nhịp nhẹ mỗi phách cho vui tai.
    for (let k = 0; k < notes.length + 1; k++) {
      const tick = this.tone(2400, start + k * beatSeconds, 0.03, { type: "square", volume: 0.012 });
      if (tick) this.musicNodes.push(tick);
    }
    return new Promise((resolve) => {
      this.musicResolve = resolve;
      this.musicTimer = setTimeout(() => {
        this.musicNodes = [];
        this.musicResolve = null;
        resolve();
      }, total * 1000 + 80);
    });
  }

  stopMusic() {
    clearTimeout(this.musicTimer);
    (this.beatTimers || []).forEach(clearTimeout);
    this.beatTimers = [];
    for (const node of this.musicNodes) {
      try {
        node.stop();
      } catch {
        // nốt đã dừng từ trước
      }
    }
    this.musicNodes = [];
    if (this.musicResolve) {
      this.musicResolve();
      this.musicResolve = null;
    }
  }

  /** Bộ đệm nhiễu trắng (dùng cho tiếng snare và hi-hat), tạo một lần rồi dùng lại. */
  noiseBuffer() {
    if (!this._noise) {
      const ctx = this.ctx;
      this._noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
      const data = this._noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this._noise;
  }

  /** Trống kick: sóng sine trượt tần số từ cao xuống thấp nghe như tiếng "bùm". */
  kick(t) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    gain.gain.setValueAtTime(0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.35);
    this.musicNodes.push(osc);
  }

  /** Snare (tiếng "tách") hoặc hi-hat (tiếng "xì" ngắn): nhiễu trắng qua bộ lọc. */
  noiseHit(t, { filter = "bandpass", freq = 1800, volume = 0.25, length = 0.16 } = {}) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    const biquad = this.ctx.createBiquadFilter();
    biquad.type = filter;
    biquad.frequency.value = freq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + length);
    src.connect(biquad).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + length + 0.02);
    this.musicNodes.push(src);
  }

  /**
   * Beat hip-hop kiểu "boom bap": kick ở phách 1 và 3, snare ở phách 2 và 4, hi-hat mỗi nửa phách,
   * kèm bass và một câu riff ngắn. `onBeat(index)` được gọi ở mỗi phách để robot nhảy theo nhịp.
   * Trả về Promise kết thúc khi hết bài (hoặc khi bị stopMusic()).
   */
  playHipHop({ bpm = 96, bars = 8, onBeat = () => {} } = {}) {
    if (!this.ctx) return Promise.resolve();
    this.stopMusic();
    const beat = 60 / bpm;
    const start = this.ctx.currentTime + 0.1;
    const totalBeats = bars * 4;
    const bassLine = ["C2", "C2", "D#2", "F2", "G2", "G2", "F2", "D#2"]; // giai điệu bass lặp lại
    const riff = ["C4", "D#4", "G4", "A#4"];

    for (let b = 0; b < totalBeats; b++) {
      const t = start + b * beat;
      const inBar = b % 4;
      if (inBar === 0 || inBar === 2) this.kick(t);
      if (inBar === 2 && b % 8 === 6) this.kick(t + beat * 0.5); // kick phụ cho có "groove"
      if (inBar === 1 || inBar === 3) this.noiseHit(t, { volume: 0.3 });
      this.noiseHit(t, { filter: "highpass", freq: 7000, volume: 0.06, length: 0.05 });
      this.noiseHit(t + beat / 2, { filter: "highpass", freq: 7000, volume: 0.04, length: 0.04 });
      const bass = this.tone(noteToFreq(bassLine[b % 8]), t, beat * 0.9, { type: "triangle", volume: 0.16, release: 0.08 });
      if (bass) this.musicNodes.push(bass);
      // Riff "bíp" kiểu robot ở nửa sau mỗi 2 ô nhịp.
      if (b % 8 >= 4) {
        const lead = this.tone(noteToFreq(riff[b % 4]), t + beat / 2, beat * 0.35, { type: "square", volume: 0.025 });
        if (lead) this.musicNodes.push(lead);
      }
    }

    // Báo nhịp cho phần hoạt hình (setTimeout đủ chính xác cho mắt người).
    const delay = (start - this.ctx.currentTime) * 1000;
    this.beatTimers = [];
    for (let b = 0; b < totalBeats; b++) {
      this.beatTimers.push(setTimeout(() => onBeat(b), delay + b * beat * 1000));
    }

    return new Promise((resolve) => {
      this.musicResolve = resolve;
      this.musicTimer = setTimeout(() => {
        this.musicNodes = [];
        this.musicResolve = null;
        resolve();
      }, delay + totalBeats * beat * 1000 + 100);
    });
  }

  /** Trượt tần số: một nốt có cao độ thay đổi từ `from` tới `to` Hz (tiếng "víu"). */
  sweep(from, to, start, duration, { type = "sine", volume = 0.05 } = {}) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    osc.frequency.exponentialRampToValueAtTime(to, start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.03);
    gain.gain.setValueAtTime(volume, start + duration * 0.8);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain).connect(this.master);
    osc.start(start);
    osc.stop(start + duration + 0.05);
  }

  /** Nạp năng lượng laze: tiếng rít cao dần (0,6 giây). */
  laserCharge() {
    if (!this.ctx) return;
    this.sweep(180, 1600, this.ctx.currentTime + 0.01, 0.6, { volume: 0.05 });
  }

  /** Tia laze: tiếng "pew" mở đầu + tiếng "bzzz" rung liên tục trong `seconds` giây + tiếng nổ nhỏ khi tắt. */
  laserBeam(seconds = 1.6, heavy = false) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    this.sweep(2200, 300, t, 0.22, { type: "square", volume: 0.05 });
    // Tiếng "bzzz": sóng răng cưa được rung nhanh bởi một bộ dao động tần số thấp (LFO).
    const osc = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = "sawtooth";
    osc.frequency.value = heavy ? 110 : 330;
    lfo.frequency.value = heavy ? 18 : 32;
    lfoGain.gain.value = heavy ? 30 : 60;
    filter.type = "lowpass";
    filter.frequency.value = heavy ? 900 : 1800;
    lfo.connect(lfoGain).connect(osc.frequency);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(heavy ? 0.09 : 0.05, t + 0.08);
    gain.gain.setValueAtTime(heavy ? 0.09 : 0.05, t + seconds - 0.15);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + seconds + 0.05);
    lfo.stop(t + seconds + 0.05);
    this.noiseHit(t + seconds - 0.05, { filter: "lowpass", freq: 600, volume: heavy ? 0.4 : 0.2, length: 0.35 });
  }

  /** Tiếng máy biến hình: lách cách lắp ráp + tiếng rít lên + hợp âm "ta-da" khi xong (~1,9 giây). */
  transformSound() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.02;
    for (let i = 0; i < 7; i++) {
      this.noiseHit(t + i * 0.12, { filter: "bandpass", freq: 700 + Math.random() * 900, volume: 0.22, length: 0.07 });
    }
    this.sweep(120, 900, t + 0.2, 0.75, { type: "sawtooth", volume: 0.035 });
    this.noiseHit(t + 0.9, { filter: "lowpass", freq: 900, volume: 0.35, length: 0.4 });
    ["C5", "E5", "G5", "C6"].forEach((note, i) => this.tone(noteToFreq(note), t + 1.05 + i * 0.08, 0.5, { volume: 0.04 }));
  }

  /**
   * Tiếng "meo" tổng hợp: sóng răng cưa đi qua bộ lọc dải (giống khoang miệng),
   * cao độ lên rồi xuống ("mê-e-o"), bộ lọc mở rồi đóng tạo âm "e" -> "o".
   */
  meow() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.linearRampToValueAtTime(820, t + 0.18);
    osc.frequency.linearRampToValueAtTime(560, t + 0.55);
    filter.type = "bandpass";
    filter.Q.value = 6;
    filter.frequency.setValueAtTime(900, t);
    filter.frequency.linearRampToValueAtTime(2200, t + 0.2);
    filter.frequency.linearRampToValueAtTime(700, t + 0.55);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.06);
    gain.gain.setValueAtTime(0.12, t + 0.4);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.65);
  }

  /** Âm thanh trắng cho chế độ ru ngủ: tiếng mưa + giọt nước bíp nhẹ + hộp nhạc. */
  startSleepAmbience() {
    if (!this.ctx) return;
    this.stopAmbient(true);
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 3);
    gain.connect(this.master);
    const ambient = { gain, nodes: [], timers: [] };
    this.ambient = ambient;

    // 1) Tiếng mưa: nhiễu trắng đi qua bộ lọc thông thấp.
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 1100;
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 180;
    const rainGain = ctx.createGain();
    rainGain.gain.value = 0.16;
    noise.connect(highpass).connect(lowpass).connect(rainGain).connect(gain);
    noise.start();
    ambient.nodes.push(noise);

    // 2) Giọt mưa "bíp" nhẹ ngẫu nhiên.
    const drip = () => {
      if (this.ambient !== ambient) return;
      const t = ctx.currentTime;
      this.tone(1400 + Math.random() * 1400, t, 0.05, { type: "sine", volume: 0.012, dest: gain });
      ambient.timers.push(setTimeout(drip, 250 + Math.random() * 900));
    };
    drip();

    // 3) Hộp nhạc: giai điệu ru chậm, lặp lại.
    let index = 0;
    const musicBox = () => {
      if (this.ambient !== ambient) return;
      const note = LULLABY[index % LULLABY.length];
      index++;
      const t = ctx.currentTime;
      const f = noteToFreq(note);
      if (f) {
        this.tone(f, t, 1.6, { type: "sine", volume: 0.045, dest: gain, release: 1.4 });
        this.tone(f * 2, t, 0.9, { type: "triangle", volume: 0.012, dest: gain, release: 0.8 });
      }
      ambient.timers.push(setTimeout(musicBox, 750));
    };
    ambient.timers.push(setTimeout(musicBox, 1500));
  }

  stopAmbient(immediate = false) {
    const ambient = this.ambient;
    if (!ambient || !this.ctx) return;
    this.ambient = null;
    ambient.timers.forEach(clearTimeout);
    const t = this.ctx.currentTime;
    const fade = immediate ? 0.05 : 1.5;
    ambient.gain.gain.cancelScheduledValues(t);
    ambient.gain.gain.setValueAtTime(Math.max(ambient.gain.gain.value, 0.0001), t);
    ambient.gain.gain.exponentialRampToValueAtTime(0.0001, t + fade);
    setTimeout(() => {
      ambient.nodes.forEach((n) => {
        try {
          n.stop();
        } catch {
          // đã dừng
        }
      });
      ambient.gain.disconnect();
    }, fade * 1000 + 100);
  }
}

// ======================================================================
// VOICE — đọc tiếng Việt
// ======================================================================

export class Voice {
  constructor() {
    this.synth = window.speechSynthesis || null;
    this.supported = Boolean(this.synth && window.SpeechSynthesisUtterance);
    this.voices = [];
    this.voice = null;
    this.preferredURI = "";
    this.rate = 1;
    this.pitch = 1.15;
    this.speaking = false;
    this.currentId = 0;
    this.finishCurrent = null;
    this.keepAlive = []; // giữ tham chiếu utterance để Chrome không thu gom rác giữa chừng
    this.neural = null; // NeuralVoice (Piper) — gắn vào bằng useNeural()
    this.engine = "auto"; // auto | neural | browser
    this.onSpeakingChange = () => {};
    this.onVoicesChanged = () => {};
    if (this.supported) {
      this.loadVoices();
      this.synth.addEventListener?.("voiceschanged", () => this.loadVoices());
    }
  }

  loadVoices() {
    this.voices = this.synth.getVoices();
    this.selectVoice(this.preferredURI);
    this.onVoicesChanged(this.voices);
  }

  vietnameseVoices() {
    return this.voices.filter((v) => v.lang.replace("_", "-").toLowerCase().startsWith("vi"));
  }

  /** Chọn giọng theo URI đã lưu; nếu không có thì ưu tiên giọng tiếng Việt tự nhiên (Natural / Online / Google). */
  selectVoice(uri) {
    this.preferredURI = uri || "";
    const byUri = this.voices.find((v) => v.voiceURI === uri);
    if (byUri) {
      this.voice = byUri;
      return;
    }
    const vi = this.vietnameseVoices();
    this.voice = vi.find((v) => /natural|online|google/i.test(v.name)) || vi[0] || null;
  }

  get hasVietnamese() {
    return this.vietnameseVoices().length > 0;
  }

  useNeural(neural) {
    this.neural = neural;
  }

  /** Giọng tiếng Việt "Natural" của Microsoft Edge nghe rất tự nhiên — chế độ tự động sẽ ưu tiên nó. */
  get hasNaturalBrowserVoice() {
    return Boolean(this.voice && /natural|online/i.test(this.voice.name) && this.voice.lang.toLowerCase().startsWith("vi"));
  }

  shouldUseNeural() {
    if (this.engine === "browser" || !this.neural?.ready) return false;
    if (this.engine === "neural") return true;
    return !this.hasNaturalBrowserVoice;
  }

  /** Tên bộ đọc đang dùng (hiển thị cho người dùng). */
  engineLabel() {
    if (this.shouldUseNeural()) return "Giọng AI Piper";
    if (this.voice) return this.voice.name.replace(/^Microsoft\s+/i, "").replace(/\s+-\s+.*$/, "");
    return "Giọng mặc định";
  }

  /** Âm lượng thật của giọng đang phát (0..1), hoặc null nếu bộ đọc không cho đo. */
  getLevel() {
    return this.neural?.current || this.neural?.singing.length ? this.neural.level() : null;
  }


  /** Gọi trong sự kiện click để "mở khóa" bộ đọc trên một số trình duyệt. */
  unlock() {
    if (!this.supported) return;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    this.synth.speak(u);
  }

  /** Làm sạch văn bản trước khi đọc: bỏ emoji, ký hiệu markdown. */
  static clean(text) {
    return text
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/[*_#`~>|♪♫]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Chia văn bản dài thành các đoạn ≤ 180 ký tự theo dấu câu. */
  static split(text) {
    const sentences = text.split(/(?<=[.!?…;:])\s+/);
    const chunks = [];
    for (const sentence of sentences) {
      if (sentence.length <= 180) {
        chunks.push(sentence);
        continue;
      }
      let current = "";
      for (const part of sentence.split(/(?<=,)\s+/)) {
        if ((current + " " + part).length > 180 && current) {
          chunks.push(current);
          current = part;
        } else {
          current = current ? `${current} ${part}` : part;
        }
      }
      if (current) chunks.push(current);
    }
    return chunks.filter((c) => c.trim());
  }

  setSpeaking(on) {
    if (this.speaking === on) return;
    this.speaking = on;
    this.onSpeakingChange(on);
  }

  /** Đọc một câu bằng giọng trình duyệt. Promise xong khi đọc hết câu (hoặc bị huỷ). */
  speakUtterance(text, rate, pitch) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "vi-VN";
      if (this.voice) u.voice = this.voice;
      u.rate = rate;
      u.pitch = pitch;
      let ended = false;
      let watchdog = null;
      const onDone = () => {
        if (ended) return;
        ended = true;
        clearTimeout(watchdog);
        resolve();
      };
      u.onend = onDone;
      u.onerror = onDone;
      this.keepAlive = [...this.keepAlive.slice(-4), u];
      // Phòng hờ: một số trình duyệt đôi khi không bắn sự kiện onend.
      const check = () => {
        if (ended) return;
        if (!this.synth.speaking && !this.synth.pending) onDone();
        else watchdog = setTimeout(check, 1000);
      };
      watchdog = setTimeout(check, 1500 + text.length * 120);
      this.synth.speak(u);
    });
  }

  /**
   * Đọc kiểu "dòng chảy": đưa câu vào bằng push() bất cứ lúc nào (ví dụ AI vừa viết xong một câu),
   * MTD đọc ngay câu đầu trong lúc AI còn đang viết các câu sau. Gọi end() khi không còn câu nào nữa.
   * Trả về { push(text), end() -> Promise, done: Promise }.
   */
  startStream({ rate = this.rate, pitch = this.pitch } = {}) {
    this.stop(true);
    const id = ++this.currentId;
    const queue = [];
    let ended = false;
    let done = false;
    let wake = null; // đánh thức vòng đọc khi có câu mới
    let resolveDone;
    const donePromise = new Promise((resolve) => (resolveDone = resolve));
    const alive = () => !done && id === this.currentId;

    const finish = () => {
      if (done) return;
      done = true;
      if (id === this.currentId) {
        this.finishCurrent = null;
        this.setSpeaking(false);
      }
      wake?.();
      resolveDone();
    };
    this.finishCurrent = finish;
    this.setSpeaking(true);

    // Lấy câu tiếp theo; hàng đợi trống mà chưa end() thì chờ.
    const nextChunk = async () => {
      while (!queue.length && !ended && !done) await new Promise((resolve) => (wake = resolve));
      wake = null;
      return queue.shift() ?? null;
    };

    (async () => {
      if (this.shouldUseNeural()) {
        // Piper: tổng hợp câu kế tiếp trong lúc đang phát câu hiện tại.
        const playbackRate = Math.max(0.7, Math.min(1.5, rate * (1 + (pitch - 1) * 0.15)));
        const synth = (text) => this.neural.synthesize(text).catch((err) => {
          console.warn("[MTD] Piper lỗi:", err);
          return null;
        });
        const first = await nextChunk();
        let next = first === null ? null : synth(first);
        while (next && alive()) {
          const buffer = await next;
          if (!alive()) break;
          next = queue.length ? synth(queue.shift()) : null;
          if (buffer) await this.neural.play(buffer, { rate: playbackRate });
          if (!alive()) break;
          if (!next) {
            const text = await nextChunk();
            next = text === null ? null : synth(text);
          }
        }
      } else if (this.supported) {
        for (let text = await nextChunk(); text !== null && alive(); text = await nextChunk()) {
          await this.speakUtterance(text, rate, pitch);
        }
      } else {
        // Không có bộ đọc: giả lập thời gian "nói" để hiệu ứng miệng vẫn chạy.
        for (let text = await nextChunk(); text !== null && alive(); text = await nextChunk()) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(9000, 800 + text.length * 45)));
        }
      }
      finish();
    })();

    return {
      push: (text) => {
        if (done) return;
        queue.push(...Voice.split(Voice.clean(text || "")));
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
        return donePromise;
      },
      done: donePromise,
    };
  }

  /** Đọc văn bản. Trả về Promise hoàn tất khi đọc xong hoặc bị ngắt. */
  speak(text, { rate = this.rate, pitch = this.pitch } = {}) {
    const clean = Voice.clean(text || "");
    if (!clean) {
      this.stop(true);
      return Promise.resolve();
    }
    const stream = this.startStream({ rate, pitch });
    stream.push(clean);
    return stream.end();
  }

  /** Dừng đọc ngay lập tức. */
  stop(silent = false) {
    this.currentId++;
    this.neural?.stopPlayback();
    if (this.supported) this.synth.cancel();
    const finish = this.finishCurrent;
    this.finishCurrent = null;
    if (finish) finish();
    if (!silent) this.setSpeaking(false);
    else this.speaking = false;
  }
}

// ======================================================================
// LISTENER — nhận diện giọng nói liên tục
// ======================================================================

/** Chuẩn hoá để so sánh: chữ thường, bỏ dấu câu, gộp khoảng trắng. */
function normalizeSpeech(text) {
  return (text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Câu nghe được có phải tiếng vọng của câu MTD vừa nói không? (nằm trọn trong câu đó)
 * Ví dụ MTD nói "Xin chào, tớ là MTD" -> micro bắt được "là MTD" -> là tiếng vọng.
 */
export function isEchoOf(heard, spoken) {
  const h = normalizeSpeech(heard);
  return h.length > 0 && normalizeSpeech(spoken).includes(h);
}

export class Listener {
  constructor(lang = "vi-VN") {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = Boolean(Recognition);
    this.enabled = false; // người dùng đã khởi động
    this.paused = false; // MTD đang nói -> bỏ qua những gì nghe được
    this.running = false;
    this.failures = 0;
    this.restartTimer = null;
    // Chốt câu sớm: chữ nhận dạng đứng yên EARLY_COMMIT_MS thì coi như người dùng đã nói xong,
    // không cần chờ trình duyệt tự chốt (thường mất 1–1,5 giây im lặng).
    this.earlyCommitMs = 1100; // 0,8 giây hay cắt nhầm khi người dùng ngập ngừng giữa câu
    this.earlyTimer = null;
    this.committed = null; // { index, text } — câu đã chốt sớm, để không gửi lặp lần nữa
    this.echoText = {}; // chỉ số kết quả -> chữ nghe được lúc MTD đang nói (tiếng vọng)
    this.onFinal = () => {};
    this.onInterim = () => {};
    this.onStatus = () => {};
    if (!this.supported) return;

    const rec = new Recognition();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.rec = rec;

    rec.onstart = () => {
      this.running = true;
      this.echoText = {}; // phiên mới đánh số kết quả lại từ 0
      this.committed = null;
      this.onStatus(this.paused ? "paused" : "listening");
    };

    rec.onresult = (event) => this.handleResult(event);

    rec.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.enabled = false;
        this.onStatus("denied");
      } else if (event.error === "network") {
        this.failures++;
        this.onStatus("error");
      }
      // "no-speech" và "aborted" là bình thường: onend sẽ tự khởi động lại.
    };

    // Micro LUÔN bật lại (kể cả khi MTD đang nói) để người dùng nói lúc nào cũng được nghe ngay.
    rec.onend = () => {
      this.running = false;
      if (this.enabled) this.scheduleRestart();
    };
  }

  handleResult(event) {
    let interim = "";
    let interimIndex = -1;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      let transcript = result[0].transcript.trim();
      // MTD đang nói -> đây là tiếng của chính MTD vọng vào micro: ghi nhớ lại rồi bỏ qua.
      if (this.paused) {
        this.echoText[i] = transcript;
        continue;
      }
      // LỖI CŨ (v4.1): trình duyệt hay GỘP tiếng vọng của MTD và lời người dùng nói ngay sau đó vào
      // cùng một kết quả -> trước đây bỏ qua cả cụm, mất lời người dùng. Giờ chỉ cắt bỏ phần tiếng vọng.
      const echo = this.echoText[i];
      if (echo !== undefined) {
        transcript = transcript.startsWith(echo) ? transcript.slice(echo.length).trim() : "";
        if (!transcript) continue;
      }
      if (result.isFinal) {
        this.failures = 0;
        this.onInterim("");
        clearTimeout(this.earlyTimer);
        const early = this.committed?.index === i ? this.committed.text : null;
        this.committed = null;
        if (!transcript) continue;
        if (!early) {
          this.onFinal(transcript);
        } else if (transcript.length > early.length + 6) {
          // Người dùng ngập ngừng rồi nói tiếp sau khi đã chốt sớm -> gửi lại CẢ CÂU đầy đủ,
          // app.js sẽ huỷ câu trả lời cho nửa câu trước đó.
          this.onFinal(transcript);
        }
      } else if (this.committed?.index !== i) {
        interim += transcript + " ";
        interimIndex = i;
      }
    }
    if (!interim.trim()) return;
    const text = interim.trim();
    this.onInterim(text);
    clearTimeout(this.earlyTimer);
    this.earlyTimer = setTimeout(() => {
      if (this.paused || text.length < 2) return;
      this.committed = { index: interimIndex, text };
      this.onInterim("");
      this.onFinal(text);
    }, this.earlyCommitMs);
  }

  scheduleRestart() {
    clearTimeout(this.restartTimer);
    // Lỗi mạng liên tục thì chờ lâu hơn để không lặp vô hạn.
    const delay = Math.min(10000, 150 + this.failures * 1500);
    this.restartTimer = setTimeout(() => this.startEngine(), delay);
  }

  startEngine() {
    if (!this.supported || !this.enabled || this.running) return;
    try {
      this.rec.start();
    } catch {
      // Đã đang chạy — bỏ qua.
    }
  }

  start() {
    if (!this.supported) {
      this.onStatus("unsupported");
      return;
    }
    this.enabled = true;
    this.paused = false;
    this.startEngine();
  }

  /** Tắt hẳn (khi chuyển sang PhoWhisper). */
  stop() {
    this.enabled = false;
    clearTimeout(this.restartTimer);
    clearTimeout(this.earlyTimer);
    try {
      this.rec?.abort();
    } catch {
      // bỏ qua
    }
  }

  /** MTD bắt đầu nói/hát: vẫn để micro chạy nhưng bỏ qua mọi thứ nghe được (tránh tự nghe giọng mình). */
  pause() {
    if (!this.supported) return;
    this.paused = true;
    clearTimeout(this.earlyTimer);
    this.onInterim("");
    if (this.enabled) this.onStatus("paused");
  }

  /** MTD nói xong: nghe lại NGAY, không phải khởi động lại micro. */
  resume() {
    if (!this.supported || !this.enabled) return;
    this.paused = false;
    if (this.running) this.onStatus("listening");
    else this.startEngine();
  }
}
