// stt.js — Nhận dạng giọng nói tiếng Việt CHẠY TRÊN MÁY (không cần dịch vụ online của trình duyệt)
//
//  - PhoWhisper (VinAI, giấy phép BSD-3-Clause): mô hình Whisper huấn luyện thêm trên 844 giờ tiếng Việt.
//    Chạy trong server.py bằng faster-whisper (CTranslate2) — nhanh hơn chạy trong trình duyệt hàng chục lần
//    (đã đo: trong trình duyệt mất 9–30 giây cho câu 2 giây vì WebAssembly chỉ dùng được 1 nhân CPU).
//  - Silero VAD (MIT) qua thư viện @ricky0123/vad-web (ISC): mô hình nhỏ nghe micro liên tục để biết
//    lúc nào người dùng BẮT ĐẦU và NGỪNG nói, rồi cắt đúng đoạn đó đưa cho PhoWhisper.
//
// Lớp WhisperListener có cùng "giao diện" với Listener (giọng trình duyệt) trong audio-voice.js:
// start(), stop(), pause(), resume(), onFinal(text), onInterim(text), onStatus(status).

const ORT_VERSION = "1.14.0"; // phiên bản onnxruntime-web mà vad-web 0.0.24 yêu cầu
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const VAD_BASE = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.24/dist/";

// Whisper đôi khi "bịa" câu khi nghe tiếng ồn (do học từ phụ đề video). Gặp các câu này thì bỏ qua.
const HALLUCINATIONS = [
  /subscribe/i,
  /đăng ký (kênh|cho kênh)/i,
  /cảm ơn (các bạn|mọi người|quý vị) đã (theo dõi|xem|lắng nghe)/i,
  /hẹn gặp lại (các bạn|mọi người)/i,
  /like và share/i,
  /ghiền mì gõ/i,
  /phụ đề (bởi|được)/i,
  /^(\s*[.,!?…-]\s*)+$/,
];

/** Làm sạch kết quả nhận dạng; trả về "" nếu là câu "bịa" hoặc không có chữ nào. Hàm thuần — kiểm thử được. */
export function cleanTranscript(text) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!/\p{L}/u.test(t)) return "";
  if (HALLUCINATIONS.some((re) => re.test(t))) return "";
  return t;
}

/** Âm lượng trung bình (RMS) của đoạn âm thanh — dùng để bỏ các đoạn quá nhỏ (tiếng ồn nền). */
export function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Không tải được ${src}`));
    document.head.appendChild(el);
  });
}

export class WhisperListener {
  constructor() {
    this.supported = Boolean(navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode);
    this.ready = false;
    this.enabled = false;
    this.paused = false;
    this.discard = false; // đoạn nói bắt đầu trong lúc MTD đang nói -> là tiếng của MTD, bỏ đi
    this.busy = Promise.resolve(); // nhận dạng lần lượt từng câu
    this.onFinal = () => {};
    this.onInterim = () => {};
    this.onStatus = () => {};
  }

  /**
   * Chờ server báo PhoWhisper sẵn sàng (tối đa ~60 giây) rồi tải Silero VAD.
   * Server không có PhoWhisper (chạy bằng Python thường) -> báo lỗi để app dùng giọng trình duyệt.
   */
  async load() {
    for (let i = 0; i < 60; i++) {
      const res = await fetch("./stt/status").catch(() => null);
      const info = res?.ok ? await res.json() : { status: "unavailable", reason: "server cũ không hỗ trợ" };
      if (info.status === "ready") {
        this.modelName = info.model || "PhoWhisper"; // ví dụ "PhoWhisper-small-ct2 (GPU)"
        break;
      }
      if (info.status === "unavailable") throw new Error(info.reason || "server không có PhoWhisper");
      await new Promise((r) => setTimeout(r, 1000));
    }
    await loadScript(`${ORT_BASE}ort.min.js`);
    await loadScript(`${VAD_BASE}bundle.min.js`);
    this.ready = true;
  }

  /** Gửi đoạn âm thanh 16 kHz (Float32Array) về server, nhận lại văn bản. */
  async transcribe(audio) {
    const res = await fetch("./stt", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: audio });
    if (!res.ok) throw new Error(`Server nhận dạng lỗi HTTP ${res.status}`);
    const data = await res.json();
    return cleanTranscript(data.text);
  }

  async start() {
    if (!this.ready) throw new Error("PhoWhisper chưa tải xong");
    this.enabled = true;
    this.paused = false;
    this.vad = await window.vad.MicVAD.new({
      model: "v5",
      baseAssetPath: VAD_BASE,
      onnxWASMBasePath: ORT_BASE,
      positiveSpeechThreshold: 0.5, // ≥ 0.5: là tiếng người (0.6 hay bỏ sót khi nói nhỏ)
      negativeSpeechThreshold: 0.35,
      redemptionFrames: 26, // im lặng ~0,83 giây (26 khung x 32 ms) thì coi là nói xong — không cắt đôi câu khi ngập ngừng
      preSpeechPadFrames: 10, // giữ thêm ~0,3 giây trước khi bắt đầu để không mất chữ đầu
      minSpeechFrames: 6, // đoạn ngắn hơn ~0,2 giây là tiếng động, không phải lời nói
      onSpeechStart: () => {
        this.discard = this.paused;
        if (!this.discard) this.onInterim("🎙 đang nghe...");
      },
      onVADMisfire: () => this.onInterim(""),
      onSpeechEnd: (audio) => this.handleSpeech(audio),
    });
    this.vad.start();
    this.onStatus("listening");
  }

  handleSpeech(audio) {
    if (this.paused || this.discard || rms(audio) < 0.004) {
      this.onInterim("");
      return;
    }
    this.onInterim("⏳ đang nhận dạng...");
    this.busy = this.busy.then(async () => {
      try {
        const started = performance.now();
        const text = await this.transcribe(audio);
        console.info(`[MTD] PhoWhisper: "${text}" (${Math.round(performance.now() - started)} ms cho ${(audio.length / 16000).toFixed(1)} giây)`);
        this.onInterim("");
        if (text && !this.paused) this.onFinal(text);
      } catch (err) {
        console.warn("[MTD] Lỗi nhận dạng:", err);
        this.onInterim("");
      }
    });
  }

  /** MTD đang nói: vẫn nghe nhưng bỏ qua (tránh tự nghe giọng mình). */
  pause() {
    this.paused = true;
    if (this.enabled) this.onStatus("paused");
  }

  resume() {
    this.paused = false;
    if (this.enabled) this.onStatus("listening");
  }

  stop() {
    this.enabled = false;
    this.vad?.destroy();
    this.vad = null;
  }
}
