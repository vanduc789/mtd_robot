// nlp.js — "Bộ hiểu ngôn ngữ" của MTD (NLP + Machine Learning + RAG)
//
//  1) Embedding (deep learning): mô hình multilingual-e5-small (MIT) chạy NGAY TRONG trình duyệt bằng
//     Transformers.js (Apache-2.0), biến mỗi câu thành vector 384 số. File mô hình nằm sẵn trong models/.
//  2) Bộ phân loại (machine learning): Logistic Regression huấn luyện bằng scikit-learn (xem ml/train_classifiers.py),
//     trọng số lưu trong models/emotion.json và models/intent.json. Ở đây chỉ cần nhân ma trận + softmax.
//  3) RAG (Retrieval-Augmented Generation):
//     - Trí nhớ dài hạn: lưu những điều người dùng kể, khi nói chuyện thì tìm lại ký ức liên quan nhất.
//     - Kiến thức: tra Wikipedia tiếng Việt (CC BY-SA) rồi đưa đoạn trích cho não AI tham khảo.

export const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6";
const EMBED_MODEL = "Xenova/multilingual-e5-small";

// ======================================================================
// TOÁN HỌC CƠ BẢN (hàm thuần, kiểm thử được bằng Node)
// ======================================================================

/** Độ giống nhau cosine của hai vector đã chuẩn hoá (= tích vô hướng). Từ -1 đến 1. */
export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** Softmax: biến điểm số thành xác suất có tổng = 1. */
export function softmax(scores) {
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(s - max)); // trừ max để không bị tràn số
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * Chạy bộ phân loại Logistic Regression đã huấn luyện: điểm = W·x + b, rồi softmax.
 * Trả về { label, prob, probs: { nhãn: xác suất } }.
 */
export function classify(model, vector) {
  const scores = model.weights.map((row, k) => {
    let s = model.bias[k];
    for (let i = 0; i < row.length; i++) s += row[i] * vector[i];
    return s;
  });
  const probs = softmax(scores);
  let best = 0;
  for (let k = 1; k < probs.length; k++) if (probs[k] > probs[best]) best = k;
  return {
    label: model.classes[best],
    prob: probs[best],
    probs: Object.fromEntries(model.classes.map((c, k) => [c, probs[k]])),
  };
}

// ======================================================================
// TRÍ NHỚ DÀI HẠN (RAG trên những điều người dùng từng kể)
// ======================================================================

const MEMORY_KEY = "mtd.memory.v1";
const MAX_MEMORIES = 400;

/**
 * Lưu câu người dùng kể kèm vector embedding. Khi trò chuyện, tìm các câu có nghĩa gần nhất
 * để nhắc não AI ("Đức từng kể: tớ có con mèo tên Mướp").
 */
export class MemoryStore {
  constructor(items = null, storage = globalThis.localStorage) {
    this.storage = storage;
    this.items = items ?? this.read();
  }

  read() {
    try {
      return JSON.parse(this.storage?.getItem(MEMORY_KEY) || "[]");
    } catch {
      return [];
    }
  }

  save() {
    try {
      this.storage?.setItem(MEMORY_KEY, JSON.stringify(this.items));
    } catch {
      // đầy bộ nhớ -> bỏ bớt ký ức cũ nhất rồi thử lại lần sau
      this.items = this.items.slice(-Math.floor(MAX_MEMORIES / 2));
    }
  }

  /** Thêm ký ức. Bỏ qua nếu gần như trùng một ký ức đã có. Trả về true nếu đã thêm. */
  add(text, who, vector, time = Date.now()) {
    const duplicate = this.items.some((m) => m.who === who && cosine(m.v, vector) > 0.97);
    if (duplicate) return false;
    this.items.push({ text, who, t: time, v: Array.from(vector, (x) => Math.round(x * 1000) / 1000) });
    if (this.items.length > MAX_MEMORIES) this.items.shift();
    return true;
  }

  /** Tìm `k` ký ức của `who` giống `vector` nhất, độ giống ≥ minScore, bỏ qua các câu trong `exclude`. */
  // minScore = 0.9: đo thực tế với e5, câu liên quan ≥ 0.91, câu không liên quan ≤ 0.89 (xem README).
  search(vector, who, { k = 3, minScore = 0.9, exclude = new Set() } = {}) {
    return this.items
      .filter((m) => m.who === who && !exclude.has(m.text))
      .map((m) => ({ ...m, score: cosine(m.v, vector) }))
      .filter((m) => m.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  forget(who = null) {
    this.items = who ? this.items.filter((m) => m.who !== who) : [];
    this.save();
  }
}

/** Câu có đáng nhớ không? Câu kể về bản thân, đủ dài, không phải câu lệnh/câu hỏi ngắn. */
export function isMemorable(text) {
  const words = text.trim().split(/\s+/);
  if (words.length < 4) return false;
  if (/\?\s*$/.test(text) && !/(^|\s)(tớ|mình|tôi|em)(\s|$)/iu.test(text)) return false;
  return /(^|\s)(tớ|mình|tôi|em|nhà tớ|nhà mình|bạn tớ|mẹ tớ|bố tớ|lớp tớ)(\s|$)/iu.test(text);
}

// ======================================================================
// KIẾN THỨC: WIKIPEDIA TIẾNG VIỆT (RAG trên nguồn mở CC BY-SA)
// ======================================================================

const QUESTION_PATTERN =
  /(là gì|là ai|là con gì|tại sao|vì sao|bao nhiêu|ở đâu|khi nào|năm nào|như thế nào|thế nào là|ai là|ai đã|ai phát minh|nghĩa là gì|giải thích|cho tớ biết về|tìm hiểu về|thông tin về|có biết .+ không)/iu;

/** Câu hỏi kiến thức (nên tra cứu) hay chỉ là trò chuyện? */
export function isKnowledgeQuestion(text) {
  if (/(cậu|bạn|mtd)\s+(là ai|là gì|ở đâu|bao nhiêu tuổi|thích gì)/iu.test(text)) return false; // hỏi về chính MTD
  if (/(tớ|mình|tôi)\s+(là ai|ở đâu)/iu.test(text)) return false;
  return QUESTION_PATTERN.test(text);
}

/** Bỏ các từ đệm để từ khoá tìm kiếm gọn hơn: "MTD ơi cho tớ hỏi mặt trăng là gì?" -> "mặt trăng". */
// Lưu ý: \b của JavaScript không hiểu chữ có dấu ("ơi" bị coi là không phải chữ),
// nên ranh giới từ được viết tay: (^|\s) ở trước và (?=\s|$) ở sau.
const FILLER_WORDS = new RegExp(
  "(^|\\s)(?:cho tớ biết về|tìm hiểu về|thông tin về|cho tớ hỏi|cho mình hỏi|tớ muốn biết|cậu có biết|có biết|giải thích|" +
    "thế nào là|như thế nào|nghĩa là gì|là gì|là ai|tại sao|vì sao|khi nào|ở đâu|bao nhiêu|" +
    "mtd|ơi|cậu|bạn|không|nhỉ|vậy|thế|à|ạ|nhé|hả)(?=\\s|$)",
  "giu"
);

export function toSearchQuery(text) {
  let query = ` ${text.replace(/[?!.,…]/g, " ")} `;
  // Lặp vài lần vì các từ đệm đứng sát nhau dùng chung dấu cách.
  for (let i = 0; i < 3; i++) query = query.replace(FILLER_WORDS, " ");
  return query.replace(/\s+/g, " ").trim();
}

/**
 * Tra Wikipedia tiếng Việt: tìm 2 bài phù hợp nhất và lấy đoạn mở đầu (đã là văn bản thuần).
 * Trả về [{ title, url, text }]. Lỗi mạng / quá 5 giây -> mảng rỗng (MTD vẫn trả lời bình thường).
 */
export async function searchWikipedia(question, { limit = 2, timeoutMs = 5000 } = {}) {
  const query = toSearchQuery(question) || question;
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*", // cho phép gọi từ trình duyệt (CORS)
    generator: "search",
    gsrsearch: query,
    gsrlimit: String(limit),
    prop: "extracts",
    exintro: "1",
    explaintext: "1",
    exsentences: "6",
  });
  try {
    const res = await fetch(`https://vi.wikipedia.org/w/api.php?${params}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const data = await res.json();
    return Object.values(data.query?.pages || {})
      .sort((a, b) => a.index - b.index)
      .filter((p) => p.extract && p.extract.length > 40)
      .map((p) => ({
        title: p.title,
        url: `https://vi.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`,
        text: p.extract.replace(/\s+/g, " ").slice(0, 900),
      }));
  } catch {
    return [];
  }
}

// ======================================================================
// BỘ NLP CHẠY TRONG TRÌNH DUYỆT
// ======================================================================

export class NLP {
  constructor() {
    this.ready = false;
    this.status = "idle"; // idle | loading | ready | error
    this.extractor = null;
    this.emotion = null;
    this.intent = null;
  }

  async load() {
    if (this.status === "loading" || this.status === "ready") return this.loading;
    this.status = "loading";
    this.loading = (async () => {
      const t = await import(/* @vite-ignore */ TRANSFORMERS_URL);
      t.env.allowLocalModels = true;
      // Có file trong models/ (chạy trên máy) thì đọc từ máy; không có (bản đăng trên GitHub Pages) thì tải từ Hugging Face.
      t.env.allowRemoteModels = true;
      t.env.localModelPath = new URL("./models/", location.href).href;
      const [extractor, emotion, intent] = await Promise.all([
        t.pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" }),
        fetch("./models/emotion.json").then((r) => r.json()),
        fetch("./models/intent.json").then((r) => r.json()),
      ]);
      this.extractor = extractor;
      this.emotion = emotion;
      this.intent = intent;
      this.ready = true;
      this.status = "ready";
    })().catch((err) => {
      this.status = "error";
      throw err;
    });
    return this.loading;
  }

  /** Câu -> vector 384 số (đã chuẩn hoá). `kind` = "query" hoặc "passage" theo quy ước của e5. */
  async embed(text, kind = "query") {
    const output = await this.extractor(`${kind}: ${text}`, { pooling: "mean", normalize: true });
    return output.data;
  }

  /** Phân tích một câu: ý định + cảm xúc (kèm xác suất) và vector để dùng cho trí nhớ. */
  async analyze(text) {
    const vector = await this.embed(text);
    const intent = classify(this.intent, vector);
    const emotion = classify(this.emotion, vector);
    return {
      vector,
      intent: intent.label,
      intentProb: intent.prob,
      intentThreshold: this.intent.threshold ?? 0.5,
      mood: emotion.label,
      moodProb: emotion.prob,
    };
  }
}
