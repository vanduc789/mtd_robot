// neural-voice.js — Giọng đọc AI tiếng Việt chạy offline trong trình duyệt bằng Piper TTS.
//
// Mã nguồn mở được dùng (giấy phép cho phép sử dụng):
//   - Piper TTS (MIT)                       https://github.com/rhasspy/piper
//   - piper-tts-web (MIT)                   https://github.com/Mintplex-Labs/piper-tts-web
//   - Giọng vi_VN-vais1000-medium, huấn luyện từ bộ dữ liệu VAIS-1000 (CC BY 4.0)
//     https://huggingface.co/rhasspy/piper-voices  ·  https://ieee-dataport.org/documents/vais-1000-vietnamese-speech-synthesis-corpus
//
// Mô hình giọng (~60 MB) chỉ tải một lần rồi được lưu trong bộ nhớ trình duyệt (OPFS).

import { noteToFreq } from "./audio-voice.js";

const PIPER_URL = "https://esm.run/@mintplex-labs/piper-tts-web@1.0.5";

/** Cắt khoảng lặng ở đầu và cuối đoạn âm thanh (Piper thường chèn ~0,1–0,2 giây im lặng). */
function trimSilence(ctx, buffer, threshold = 0.02) {
  const data = buffer.getChannelData(0);
  let start = 0;
  let end = data.length - 1;
  while (start < end && Math.abs(data[start]) < threshold) start++;
  while (end > start && Math.abs(data[end]) < threshold) end--;
  const length = Math.max(1, end - start + 1);
  const out = ctx.createBuffer(1, length, buffer.sampleRate);
  out.copyToChannel(data.subarray(start, start + length), 0);
  return out;
}

/**
 * Ước lượng cao độ giọng (Hz) bằng phương pháp tự tương quan (autocorrelation):
 * tìm độ trễ mà tại đó tín hiệu "giống chính nó" nhất — độ trễ đó chính là một chu kỳ dao động.
 */
function estimatePitch(buffer) {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const size = Math.min(2048, data.length);
  const offset = Math.max(0, Math.floor(data.length / 2 - size / 2)); // lấy đoạn giữa chữ
  const minLag = Math.floor(sr / 450);
  const maxLag = Math.min(Math.floor(sr / 70), size - 1);
  let bestLag = 0;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < size - lag; i++) sum += data[offset + i] * data[offset + i + lag];
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return bestLag ? sr / bestLag : 220;
}
export const NEURAL_VOICE_ID = "vi_VN-vais1000-medium";

/**
 * Tính tốc độ phát (playbackRate) cho từng chữ khi hát. Hàm thuần — kiểm thử được bằng Node.
 *
 * Cách cũ: rate = tần số nốt / cao độ chữ -> nốt cao thì chữ bị tua nhanh gấp 1,5–2 lần,
 * nghe như "chuột chip", không rõ lời. Cách mới:
 *  1) Chuyển giọng cả câu (chia cho trung bình nhân) để giai điệu nằm quanh tầm giọng tự nhiên (rate ≈ 1).
 *  2) Nén độ cao thấp còn 70% (mũ 0.7): vẫn nghe ra giai điệu lên xuống nhưng chữ ít bị méo.
 *  3) Giới hạn trong khoảng 0,8–1,25 để chữ luôn nghe rõ.
 */
export function singingRates(syllables, notes) {
  const raw = syllables.map((syl, i) => (syl ? noteToFreq(notes[i]) / syl.pitch : null));
  const valid = raw.filter((r) => r && Number.isFinite(r));
  if (!valid.length) return raw.map(() => 1);
  const center = Math.exp(valid.reduce((sum, r) => sum + Math.log(r), 0) / valid.length);
  return raw.map((r) => (r ? Math.max(0.8, Math.min(1.25, Math.pow(r / center, 0.7))) : 1));
}

export class NeuralVoice {
  constructor(getAudioContext) {
    this.getAudioContext = getAudioContext; // hàm trả về AudioContext dùng chung với SoundEngine
    this.session = null;
    this.status = "idle"; // idle | loading | ready | error
    this.error = null;
    this.loading = null;
    this.current = null; // { source, resolve } của đoạn đang phát
    this.analyser = null;
    this.levelData = null;
    this.syllables = new Map(); // bộ nhớ đệm: chữ -> { buffer, pitch }
    this.singing = []; // các nguồn âm đang được lên lịch hát
    this.singTimer = null;
    this.singResolve = null;
    this.onProgress = () => {};
  }

  // ------------------------------------------------------------------
  // HÁT: mỗi chữ được tạo riêng, đo cao độ, rồi phát nhanh/chậm để khớp nốt nhạc
  // ------------------------------------------------------------------

  async syllable(word) {
    const key = word.toLowerCase();
    if (!this.syllables.has(key)) {
      const promise = this.synthesize(key)
        .then((raw) => {
          const buffer = trimSilence(this.getAudioContext(), raw);
          return { buffer, pitch: estimatePitch(buffer) };
        })
        .catch(() => null);
      this.syllables.set(key, promise);
    }
    return this.syllables.get(key);
  }

  /** Chuẩn bị trước âm thanh cho cả một dòng lời (chạy tuần tự để không làm nghẽn bộ tổng hợp). */
  async prepareLine(words) {
    const result = [];
    for (const word of words) result.push(await this.syllable(word));
    return result;
  }

  /**
   * Hát một dòng: chữ thứ i được phát đúng lúc nốt thứ i vang lên.
   * playbackRate = (tần số nốt cần hát) / (cao độ gốc của chữ) -> chữ được "kéo" lên/xuống đúng nốt.
   */
  singLine(syllables, notes, beatSeconds) {
    const ctx = this.getAudioContext();
    this.ensureAnalyser(ctx);
    this.stopSinging();
    const start = ctx.currentTime + 0.05;
    let t = start;
    const rates = singingRates(syllables, notes);
    syllables.forEach((syl, i) => {
      const slot = (i === syllables.length - 1 ? 2 : 1) * beatSeconds;
      if (syl) {
        const rate = rates[i];
        const length = Math.min(slot * 0.95, syl.buffer.duration / rate);
        const source = ctx.createBufferSource();
        source.buffer = syl.buffer;
        source.playbackRate.value = rate;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(1, t + 0.015);
        gain.gain.setValueAtTime(1, t + Math.max(0.02, length - 0.05));
        gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
        source.connect(gain).connect(this.analyser);
        source.start(t);
        source.stop(t + length + 0.02);
        this.singing.push(source);
      }
      t += slot;
    });
    return new Promise((resolve) => {
      this.singResolve = resolve;
      this.singTimer = setTimeout(() => {
        this.singing = [];
        this.singResolve = null;
        resolve();
      }, (t - start) * 1000 + 60);
    });
  }

  stopSinging() {
    clearTimeout(this.singTimer);
    for (const source of this.singing) {
      try {
        source.stop();
      } catch {
        // đã dừng
      }
    }
    this.singing = [];
    if (this.singResolve) {
      this.singResolve();
      this.singResolve = null;
    }
  }

  get ready() {
    return this.status === "ready";
  }

  load() {
    if (this.loading || this.ready) return this.loading || Promise.resolve();
    this.status = "loading";
    this.loading = (async () => {
      try {
        const piper = await import(/* @vite-ignore */ PIPER_URL);
        this.session = await piper.TtsSession.create({
          voiceId: NEURAL_VOICE_ID,
          // LỖI CŨ: bản đóng gói của jsDelivr dùng onnxruntime-web 1.27.0 nhưng mặc định lại lấy file WASM
          // của bản 1.18.0 (trên cdnjs) -> lệch phiên bản, Piper không chạy được. Chỉ đúng đường dẫn 1.27.0.
          wasmPaths: {
            onnxWasm: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/",
            piperData: "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data",
            piperWasm: "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm",
          },
          progress: (p) => {
            if (p.total) this.onProgress(p.loaded / p.total);
          },
        });
        this.status = "ready";
        this.onProgress(1);
      } catch (err) {
        this.status = "error";
        this.error = err.message || String(err);
        throw err;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /**
   * Chuyển một đoạn văn bản thành AudioBuffer.
   * Các yêu cầu được xếp hàng chạy lần lượt: bộ tổng hợp chỉ xử lý một việc một lúc,
   * gọi chồng nhau (vừa nói vừa chuẩn bị chữ để hát) có thể gây lỗi.
   */
  synthesize(text) {
    const job = (this.queue || Promise.resolve()).then(async () => {
      const wav = await this.session.predict(text);
      return this.getAudioContext().decodeAudioData(await wav.arrayBuffer());
    });
    this.queue = job.catch(() => {});
    return job;
  }

  ensureAnalyser(ctx) {
    if (this.analyser) return;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.levelData = new Uint8Array(this.analyser.fftSize);
    this.analyser.connect(ctx.destination);
  }

  /**
   * Phát AudioBuffer. `rate` > 1 nói nhanh và cao giọng hơn một chút (giọng robot trẻ trung).
   * Trả về Promise kết thúc khi phát xong hoặc bị dừng.
   */
  play(buffer, { rate = 1 } = {}) {
    const ctx = this.getAudioContext();
    this.ensureAnalyser(ctx);
    this.stopPlayback();
    return new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      source.connect(this.analyser);
      const current = { source, resolve };
      this.current = current;
      source.onended = () => {
        if (this.current === current) this.current = null;
        resolve();
      };
      source.start();
    });
  }

  stopPlayback() {
    const current = this.current;
    this.current = null;
    if (!current) return;
    try {
      current.source.stop();
    } catch {
      // đã dừng
    }
    current.resolve();
  }

  /** Âm lượng hiện tại 0..1 — dùng để robot nhép miệng theo giọng thật. */
  level() {
    if (!this.analyser || (!this.current && !this.singing.length)) return 0;
    this.analyser.getByteTimeDomainData(this.levelData);
    let sum = 0;
    for (const v of this.levelData) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    return Math.min(1, Math.sqrt(sum / this.levelData.length) * 4);
  }
}
