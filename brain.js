// brain.js — "Bộ não" của MTD
// 1) Bộ xử lý ngoại tuyến: nhận diện ý định + cảm xúc bằng từ khóa, máy tính, câu đố, kho truyện, bài hát.
// 2) Cổng gọi AI (Claude / OpenAI / Gemini) khi người dùng nhập API key trong phần cài đặt.

import { SYSTEM_PROMPT } from "./system-prompt.js";
import { LocalLLM, webgpuSupported } from "./local-llm.js";

// ======================================================================
// TIỆN ÍCH CHUỖI
// ======================================================================

/** Bỏ dấu tiếng Việt và chuyển về chữ thường: "Buồn Quá" -> "buon qua". */
export function stripAccents(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Tìm vị trí `word` trong `text` nhưng chỉ tính khi nó là một từ trọn vẹn. Trả về -1 nếu không có. */
function findWord(text, word) {
  let from = 0;
  while (true) {
    const i = text.indexOf(word, from);
    if (i === -1) return -1;
    const before = text[i - 1];
    const after = text[i + word.length];
    const okBefore = !before || !WORD_CHAR.test(before);
    const okAfter = !after || !WORD_CHAR.test(after);
    if (okBefore && okAfter) return i;
    from = i + 1;
  }
}

/**
 * Kiểm tra câu có chứa một trong các từ khóa không.
 * - So khớp trên chuỗi CÓ dấu.
 * - Với từ khóa nhiều chữ (có dấu cách) thì so khớp thêm trên chuỗi KHÔNG dấu,
 *   để người gõ không dấu vẫn được hiểu. Từ khóa một chữ không so không dấu vì dễ nhầm
 *   (ví dụ "sợ" và "số" đều thành "so").
 */
function matchAny(lower, plain, keywords) {
  return keywords.some((kw) => {
    if (findWord(lower, kw) !== -1) return true;
    return kw.includes(" ") && findWord(plain, stripAccents(kw)) !== -1;
  });
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function normalizeInput(text) {
  return text.normalize("NFC").toLowerCase().trim();
}

// ======================================================================
// NHẬN DIỆN CẢM XÚC TỪ LỜI NÓI
// ======================================================================

export const MOOD_LABELS = {
  happy: "Vui vẻ",
  sad: "Buồn",
  angry: "Giận dữ",
  anxious: "Lo lắng",
  lonely: "Cô đơn",
  tired: "Mệt mỏi",
  surprised: "Ngạc nhiên",
  scared: "Sợ hãi",
  shy: "Xấu hổ",
  neutral: "Bình thường",
};

export const NEGATIVE_MOODS = new Set(["sad", "angry", "anxious", "lonely", "tired"]);

const MOOD_KEYWORDS = {
  sad: ["buồn", "chán", "thất vọng", "khóc", "đau lòng", "tuyệt vọng", "tệ quá", "thất bại", "nản", "nản lòng", "tủi thân", "tồi tệ", "suy sụp", "tổn thương", "bị điểm kém", "trượt"],
  lonely: ["cô đơn", "một mình", "lẻ loi", "không ai", "chẳng ai", "trống trải", "nhớ nhà", "bị bỏ rơi", "không có bạn"],
  anxious: ["lo", "lo lắng", "lo âu", "sợ", "căng thẳng", "hồi hộp", "bất an", "áp lực", "stress", "hoảng", "sắp thi", "run quá"],
  angry: ["giận", "tức", "bực", "điên", "cáu", "khó chịu", "ghét", "ức chế", "bực mình", "tức giận"],
  tired: ["mệt", "kiệt sức", "đuối", "uể oải", "oải", "mệt mỏi", "rã rời", "hết pin"],
  happy: ["vui", "hạnh phúc", "tuyệt vời", "sướng", "phấn khích", "hào hứng", "yêu đời", "điểm cao", "thành công", "haha", "hihi", "vui quá", "đỗ rồi", "được khen"],
};

// Từ phủ định đứng ngay trước từ khóa cảm xúc ("không buồn", "hết mệt") thì bỏ qua.
const NEGATION_ACCENT = /(không|chẳng|chả|hết|đỡ|bớt)\s*$/;
const NEGATION_PLAIN = /(khong|chang|cha|het|do|bot)\s*$/;

function countMood(lower, plain, keywords) {
  let score = 0;
  for (const kw of keywords) {
    const checks = [[lower, kw, NEGATION_ACCENT]];
    if (kw.includes(" ")) checks.push([plain, stripAccents(kw), NEGATION_PLAIN]);
    for (const [text, word, negation] of checks) {
      const idx = findWord(text, word);
      if (idx === -1) continue;
      const before = text.slice(Math.max(0, idx - 10), idx);
      if (!negation.test(before)) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

/** Trả về cảm xúc nổi bật nhất trong câu ("sad", "happy"...) hoặc null nếu không rõ. */
export function detectMood(text) {
  const lower = normalizeInput(text);
  const plain = stripAccents(lower);
  let best = null;
  let bestScore = 0;
  // Thứ tự ưu tiên khi bằng điểm: cảm xúc tiêu cực trước (cần được an ủi hơn).
  for (const mood of ["sad", "lonely", "anxious", "angry", "tired", "happy"]) {
    const score = countMood(lower, plain, MOOD_KEYWORDS[mood]);
    if (score > bestScore) {
      best = mood;
      bestScore = score;
    }
  }
  return best;
}

/** Cảm xúc do bộ phân loại học máy đoán (chỉ dùng khi đủ chắc chắn và không phải "bình thường"). */
export function mlMood(nlp) {
  if (!nlp || nlp.mood === "neutral" || nlp.moodProb < 0.7) return null; // bộ cảm xúc đúng ~70% nên chỉ tin khi rất chắc
  return nlp.mood === "surprised" ? null : nlp.mood; // ngạc nhiên không cần an ủi
}

/** Đoạn prompt RAG: ký ức liên quan + tài liệu tham khảo. */
export function describeRetrieved(context, owner) {
  let out = "";
  if (context.memories?.length) {
    const who = context.viewer?.kind === "friend" ? context.viewer.names[0] : owner || "cậu ấy";
    out += `\n\n## Ký ức liên quan (những điều ${who} từng kể với MTD trước đây — nhắc lại tự nhiên nếu hợp)\n`;
    out += context.memories.map((m) => `- ${m.text} (${new Date(m.t).toLocaleDateString("vi-VN")})`).join("\n");
  }
  if (context.knowledge?.length) {
    out += "\n\n## Tài liệu tham khảo vừa tra trên Wikipedia tiếng Việt (dùng nếu liên quan; kể lại ngắn gọn bằng lời của MTD, không đọc nguyên văn, không bịa thêm số liệu)\n";
    out += context.knowledge.map((d) => `### ${d.title}\n${d.text}`).join("\n");
  }
  return out;
}

// ======================================================================
// NGƯỜI ĐỨNG TRƯỚC CAMERA + LỜI KHEN (XẤU HỔ) + TÊN
// ======================================================================

/**
 * Mô tả cho AI biết ai đang đứng trước camera (do nhận diện khuôn mặt cung cấp).
 * viewer = { kind: "owner" | "friend" | "stranger" | "group", names: [...] }
 */
export function describeViewer(viewer, owner) {
  if (!viewer) return "";
  const host = owner || "chủ nhân";
  if (viewer.kind === "owner") return `Camera xác nhận: người đang nói chuyện chính là ${host}.`;
  if (viewer.kind === "friend") {
    return `Camera nhận ra: người đang nói chuyện là ${viewer.names.join(", ")} — bạn của ${host}, KHÔNG phải ${host}. Hãy gọi đúng tên ${viewer.names[0]}, xưng "tớ" và gọi "bạn".`;
  }
  if (viewer.kind === "stranger") {
    return `Camera nhận ra: người đang nói chuyện là MỘT NGƯỜI LẠ, KHÔNG phải ${host}. Hãy lịch sự, xưng "tớ" gọi "bạn", giới thiệu mình là MTD — robot bạn thân của ${host}. Không kể chuyện riêng của ${host} cho người lạ.`;
  }
  if (viewer.kind === "group") {
    return `Camera thấy nhiều người cùng lúc: ${viewer.names.join(", ")}. Hãy nói chuyện với cả nhóm, nhớ ${host} là bạn thân của MTD.`;
  }
  return "";
}

const COMPLIMENT_KEYWORDS = [
  "đẹp trai", "dễ thương", "đáng yêu", "cute", "giỏi quá", "giỏi thế", "giỏi ghê", "giỏi lắm",
  "thông minh quá", "thông minh thế", "thông minh ghê", "tuyệt vời quá", "đỉnh quá", "đỉnh thế", "ngầu quá", "ngầu thế",
  "xịn quá", "xịn thế", "yêu cậu", "yêu mtd", "yêu bạn", "thích cậu", "thích mtd", "thương cậu", "quý cậu",
  "khen cậu", "khen mtd", "xinh quá", "xinh thế", "đẹp quá", "đẹp thế", "hôn cậu", "hôn mtd", "cậu giỏi", "cậu đẹp",
  "mtd giỏi", "mtd đẹp", "cậu tuyệt", "mtd tuyệt",
];

/** Người dùng khen MTD (đẹp, giỏi, dễ thương, yêu...) -> true. */
export function detectCompliment(text) {
  const lower = normalizeInput(text);
  const plain = stripAccents(lower);
  // "không đẹp", "chẳng giỏi" -> không phải lời khen.
  if (/(không|chẳng|chả|đâu có)\s+(đẹp|giỏi|dễ thương|đáng yêu|thông minh|ngầu|xịn)/u.test(lower)) return false;
  return matchAny(lower, plain, COMPLIMENT_KEYWORDS);
}

export const SHY_LINES = [
  "Ơ... cậu khen vậy làm tớ ngại quá đi. Đèn LED trên má tớ đỏ hết cả lên rồi nè!",
  "Hihi, tớ... tớ xấu hổ quá. Bộ xử lý của tớ đang nóng lên vì ngượng đấy!",
  "Thôi mà, đừng khen nữa, tớ ngượng chín cả mạch điện luôn rồi. Nhưng mà... cảm ơn cậu nhiều nha!",
];

const NOT_A_NAME = /^(không|có|ừ|vâng|dạ|chào|xin chào|ok|okay|ai|gì|bạn|cậu|tớ|mình|chào bạn|chào cậu)$/iu;

/**
 * Lấy tên người dùng tự giới thiệu. Với `loose = true` (khi MTD vừa hỏi tên),
 * chấp nhận cả câu ngắn kiểu "Nam", "mình là Nam", "tên Nam".
 */
export function extractName(text, loose = false) {
  const clean = text.trim().replace(/[.!?,…]+$/u, "");
  const strict = /(?:tên (?:tớ|mình|tôi|em|tao|cháu) là|(?:tớ|mình|tôi|em|tao|cháu) tên là|gọi (?:tớ|mình|tôi|em|tao|cháu) là)\s+([\p{L}]+(?:\s+[\p{L}]+)?)/iu.exec(clean);
  let name = strict?.[1];
  if (!name && loose) {
    const m =
      /(?:^|\s)(?:tên|là)\s+([\p{L}]+(?:\s+[\p{L}]+)?)$/iu.exec(clean) ||
      /^([\p{L}]+(?:\s+[\p{L}]+)?)$/u.exec(clean);
    name = m?.[1];
  }
  if (!name) return null;
  name = name.replace(/\s+(nhé|nha|nhá|đấy|đó|ạ|nè|à)$/iu, "").trim();
  if (NOT_A_NAME.test(name)) return null;
  return name.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
}

// ======================================================================
// NHẬN DIỆN Ý ĐỊNH (INTENT)
// ======================================================================

// ======================================================================
// ĐỘNG TÁC THEO LỆNH (bắt tay, xoa đầu, vỗ tay...)
// ======================================================================

// Thứ tự = ưu tiên: "chạm tay vào đầu" phải được xét trước "chạm tay".
export const GESTURES = [
  { name: "hiphop", ms: 0, state: "singing", keywords: ["hip hop", "hiphop", "hip-hop", "nhảy hip", "break dance", "breakdance", "nhảy break", "nhảy robot", "quẩy hip", "popping", "nhảy rap", "nhảy cực cháy", "nhảy thật ngầu", "nhảy ngầu"], lines: ["Yo yo! DJ MTD lên sóng! Bật beat hip-hop nào!", "Check mic, một hai, một hai! Chế độ vũ công hip-hop: kích hoạt!"] },
  { name: "pat-head", ms: 4200, state: "greeting", keywords: ["xoa đầu", "chạm tay vào đầu", "chạm tay lên đầu", "chạm vào đầu", "sờ đầu", "gãi đầu", "vỗ đầu", "đặt tay lên đầu", "tay lên đầu", "để tay lên đầu"], lines: ["Đây, tớ xoa đầu mình nè! Tay tớ duỗi dài ra được như ống lồng đấy, tiện chưa?", "Gãi gãi... à, đầu tớ bằng kim loại nên không ngứa, nhưng làm vậy trông dễ thương phải không?"] },
  { name: "handshake", ms: 3500, state: "greeting", keywords: ["bắt tay"], lines: ["Bắt tay nào! Rất vui được làm bạn với cậu. Tay tớ bằng kim loại hơi lạnh một chút, cậu thông cảm nha.", "Bắt tay thật chặt! Kể từ giờ mình là đồng đội nhé."] },
  { name: "high-five", ms: 2600, state: "greeting", keywords: ["đập tay", "high five", "chạm tay", "đập tay nào"], lines: ["Đập tay nào! Bốp! Năng lượng truyền sang rồi đó!"] },
  { name: "wave", ms: 3000, state: "greeting", keywords: ["vẫy tay", "vẫy chào"], lines: ["Xin chào, xin chào! Tớ vẫy tay chào cậu nè!"] },
  { name: "clap", ms: 3000, state: "greeting", keywords: ["vỗ tay"], lines: ["Bốp bốp bốp! Tớ vỗ tay chúc mừng cậu!"] },
  { name: "arms-up", ms: 3000, state: "greeting", keywords: ["giơ tay lên", "giơ hai tay", "giơ cả hai tay", "hoan hô", "đầu hàng"], lines: ["Giơ cả hai tay lên nè! Hoan hô!"] },
  { name: "salute", ms: 3000, state: "idle", keywords: ["chào kiểu quân đội", "chào cờ", "nghiêm chào", "chào kiểu chiến sĩ", "chào nghiêm"], lines: ["Báo cáo! Robot MTD có mặt, sẵn sàng nhận nhiệm vụ!"] },
  { name: "hug", ms: 4000, state: "comforting", keywords: ["ôm tớ", "ôm mình", "ôm cái", "ôm một cái", "ôm đi", "ôm tớ đi"], lines: ["Ôm cậu một cái thật chặt nè. Dù là robot, tớ vẫn muốn cậu thấy ấm áp."] },
  { name: "nod", ms: 2000, state: "greeting", keywords: ["gật đầu"], lines: ["Gật gật! Tớ đồng ý với cậu!"] },
  { name: "shake-head", ms: 2000, state: "talking", keywords: ["lắc đầu"], lines: ["Lắc lắc... không không không!"] },
  { name: "dance", ms: 5000, state: "singing", keywords: ["nhảy đi", "nhảy múa", "múa đi", "nhảy một điệu", "quẩy đi", "nhảy cho tớ xem", "nhảy đê", "nhảy nào"], lines: ["Bật chế độ vũ công! Bíp bíp bíp, lắc lư nào!"] },
  { name: "think", ms: 3500, state: "calculating", keywords: ["làm mặt suy nghĩ", "suy nghĩ đi", "tư thế suy nghĩ", "làm bộ suy nghĩ"], lines: ["Hmm... bộ xử lý đang suy nghĩ cực kỳ nghiêm túc..."] },
];

// ======================================================================
// DI CHUYỂN & NHÀO LỘN
// ======================================================================

// Thứ tự = ưu tiên: "nhào lộn ngang" phải khớp "cartwheel" trước khi khớp "nhào lộn" của "flip".
export const MOVES = [
  // Biến hình: dạng cụ thể đứng TRƯỚC "biến hình" chung chung.
  // Nhân vật có bản quyền -> MTD giải thích và biến thành mèo máy của riêng mình.
  { name: "transform-cat", keywords: ["doremon", "doraemon", "đô rê mon", "đôrêmon", "đô-rê-mon", "đoremon"], lines: ["Đô-rê-mon là nhân vật có bản quyền nên tớ không hóa thành bạn ấy được. Nhưng tớ có dạng mèo máy của riêng tớ nè! Biến hình... Meo meo!"] },
  { name: "transform-cat", keywords: ["biến thành mèo", "biến thành con mèo", "biến thành mèo máy", "dạng mèo", "mèo máy", "hóa thành mèo", "hoá thành mèo", "hóa mèo", "hoá mèo", "biến hình thành mèo"], lines: ["Biến hình mèo máy! Mọc tai... gắn ria... lắp đuôi... Meo meo!", "Chế độ mèo máy: kích hoạt! Meo, tớ có đuôi rồi nè!"] },
  { name: "transform-car", keywords: ["biến thành xe", "biến thành ô tô", "biến thành xe đua", "biến thành xe hơi", "biến hình thành xe", "chế độ xe đua", "dạng xe đua", "hóa thành xe", "hoá thành xe"], lines: ["Kích hoạt chế độ xe đua! Gập tay... thu đầu... lắp bánh... Brừm brừm!", "Biến hình thành xe đua nào! Bánh xe đã sẵn sàng!"] },
  { name: "transform-battle", keywords: ["chế độ chiến đấu", "biến thành chiến binh", "dạng chiến binh", "dạng chiến đấu", "biến hình chiến đấu", "mặc giáp", "giáp chiến đấu", "biến thành siêu nhân", "biến thành người máy chiến đấu"], lines: ["Kích hoạt chế độ chiến binh! Lắp giáp... khóa khớp... nạp năng lượng... Hoàn tất!", "Giáp chiến đấu: kích hoạt! Đèn đỏ bật, sẵn sàng bảo vệ cậu!"] },
  { name: "transform-normal", keywords: ["trở lại bình thường", "trở về bình thường", "biến lại", "về dạng cũ", "dạng bình thường", "hủy biến hình", "huỷ biến hình", "trở về hình dạng cũ", "bỏ giáp", "cởi giáp", "thôi biến hình"], lines: ["Trở về dạng bình thường! Tháo giáp... bung tay... ngóc đầu lên... Xong!"] },
  { name: "transform", keywords: ["biến hình", "biến đổi hình dạng", "transform", "biến dạng"], lines: ["Biến hình!", "Xem tớ biến hình nè!"] },
  { name: "laser", keywords: ["bắn laze", "bắn laser", "bắn la de", "bắn tia", "tia laze", "tia laser", "phóng laze", "phóng tia", "laze", "laser", "khai hỏa", "khai hoả", "bắn súng", "bắn đi", "nhả đạn", "chiêu cuối"], lines: ["Nạp năng lượng... Bắn laze! Chiu chiu!", "Khai hỏa! Đừng lo, laze của tớ chỉ là ánh sáng đồ chơi thôi!", "Mắt laze: kích hoạt! Bzzzz!"] },
  { name: "cartwheel", keywords: ["lộn ngang", "lộn bánh xe", "nhào lộn ngang", "lăn vòng", "lăn tròn", "lộn sang bên"], lines: ["Lộn ngang kiểu bánh xe đây! Vèo vèo!", "Bánh xích tạm nghỉ, tớ lộn ngang cho nhanh nè!"] },
  { name: "flip", keywords: ["lộn vòng", "lộn nhào", "nhào lộn", "lộn ngược", "santo", "salto", "lộn ra sau", "lộn một vòng", "backflip", "lộn người"], lines: ["Chuẩn bị... ba, hai, một... lộn vòng nào!", "Xem tớ nhào lộn này! Con quay hồi chuyển cân bằng: kích hoạt!", "Hít một hơi... à không, tớ là robot, nạp đà thôi... Hấp!"] },
  { name: "spin", keywords: ["xoay vòng", "quay vòng", "xoay tròn", "quay tròn", "xoay người", "quay người", "xoay một vòng", "quay một vòng", "quay lưng"], lines: ["Xoay một vòng nè! Cậu thấy lưng tớ chưa, có cả ốc vít đấy!"] },
  { name: "jump", keywords: ["nhảy lên", "bật lên", "nhảy cao", "bật cao", "nhảy tưng"], lines: ["Hấp! Bật nhảy bằng lò xo trong chân đây!"] },
  { name: "left", keywords: ["sang trái", "qua trái", "sang bên trái", "qua bên trái", "về bên trái", "lăn sang trái", "rẽ trái"], lines: ["Bánh xích quay... sang trái nào!"] },
  { name: "right", keywords: ["sang phải", "qua phải", "sang bên phải", "qua bên phải", "về bên phải", "lăn sang phải", "rẽ phải"], lines: ["Rè rè... chạy sang phải đây!"] },
  { name: "come", keywords: ["lại đây", "đến đây", "lại gần", "tới đây", "về đây", "về giữa", "về chỗ", "tiến lại gần"], lines: ["Tớ đến đây! Rè rè rè..."] },
  { name: "patrol", keywords: ["chạy vòng", "chạy quanh", "đi dạo", "đi một vòng", "chạy một vòng", "đi tuần", "chạy qua chạy lại", "chạy nhảy", "di chuyển đi", "chạy loanh quanh"], lines: ["Bắt đầu tuần tra khu vực! Bánh xích tăng tốc!"] },
];

/** Tìm lệnh di chuyển trong câu, trả về object hoặc null. */
export function detectMove(text) {
  const lower = normalizeInput(text);
  const plain = stripAccents(lower);
  const move = MOVES.find((m) => matchAny(lower, plain, m.keywords));
  return move ? { ...move, line: pick(move.lines) } : null;
}

// Nhãn của bộ phân loại ý định (học máy) -> hành động của MTD.
const ML_INTENT_TO_MOVE = { laser: "laser", transform: "transform", flip: "flip", spin: "spin", jump: "jump", move_left: "left", move_right: "right", come_here: "come", patrol: "patrol" };
const ML_INTENT_TO_INTENT = { sing: "sing", story: "story", lullaby: "lullaby", riddle: "riddle", joke: "joke", time: "time" };

/**
 * Khi dò từ khoá không ra lệnh nào, dùng kết quả học máy (hiểu theo NGHĨA câu).
 * Trả về { move } | { gesture } | { intent } | null. Chỉ tin khi xác suất ≥ ngưỡng đã chọn lúc huấn luyện.
 */
export function semanticCommand(nlp) {
  if (!nlp || nlp.intent === "chat" || nlp.intentProb < (nlp.intentThreshold ?? 0.5)) return null;
  if (ML_INTENT_TO_MOVE[nlp.intent]) {
    const move = MOVES.find((m) => m.name === ML_INTENT_TO_MOVE[nlp.intent]);
    return { move: { ...move, line: pick(move.lines) } };
  }
  if (nlp.intent === "hiphop") {
    const gesture = GESTURES.find((g) => g.name === "hiphop");
    return { gesture: { ...gesture, line: pick(gesture.lines) } };
  }
  if (ML_INTENT_TO_INTENT[nlp.intent]) return { intent: ML_INTENT_TO_INTENT[nlp.intent] };
  return null;
}

/** Tìm động tác được yêu cầu trong câu, trả về object động tác hoặc null. */
export function detectGesture(text) {
  const lower = normalizeInput(text);
  const plain = stripAccents(lower);
  const gesture = GESTURES.find((g) => matchAny(lower, plain, g.keywords));
  return gesture ? { ...gesture, line: pick(gesture.lines) } : null;
}

// Thứ tự trong danh sách = thứ tự ưu tiên.
const INTENTS = [
  ["face_forget", ["quên mặt", "quên khuôn mặt", "xóa khuôn mặt", "xoá khuôn mặt", "xóa mặt", "xoá mặt"]],
  ["face_learn", ["nhớ mặt tớ", "nhớ mặt mình", "nhớ mặt tôi", "nhớ mặt em", "ghi nhớ khuôn mặt", "nhớ khuôn mặt", "học mặt", "lưu khuôn mặt", "lưu mặt", "quét mặt", "quét khuôn mặt"]],
  ["who_am_i", ["tớ là ai", "mình là ai", "tôi là ai", "em là ai", "nhận ra tớ", "nhận ra mình", "nhận ra tôi", "nhận ra em", "biết tớ là ai", "biết mình là ai", "biết tôi là ai", "ai đang đứng"]],
  ["mimic_off", ["thôi bắt chước", "dừng bắt chước", "tắt bắt chước", "đừng bắt chước", "hết bắt chước", "thôi làm theo"]],
  ["mimic_on", ["bắt chước tớ", "bắt chước mình", "bắt chước tôi", "bắt chước em", "làm theo tớ", "làm theo mình", "làm theo tôi", "làm giống tớ", "làm giống mình", "chế độ bắt chước", "bắt chước đi", "soi gương"]],
  ["stop", ["dừng lại", "dừng hát", "thôi hát", "đừng hát", "tắt nhạc", "im lặng", "ngừng lại", "stop", "dừng", "thôi đi"]],
  ["wake", ["dậy đi", "thức dậy", "dậy thôi", "dậy rồi", "tỉnh dậy", "tắt chế độ ngủ", "tắt ru ngủ", "thoát chế độ ngủ", "wake up"]],
  ["lullaby", ["ru ngủ", "ru tớ", "ru mình", "ru em", "ru tôi", "buồn ngủ", "đi ngủ", "chúc ngủ ngon", "ngủ ngon", "muốn ngủ", "không ngủ được", "khó ngủ", "mất ngủ", "chế độ ngủ", "ngủ đông"]],
  ["sing", ["hát", "bài hát", "ca hát", "nghe nhạc", "bật nhạc", "mở nhạc", "sing", "hát đi", "mở bài", "bật bài", "nghe bài", "sáng tác bài"]],
  ["story", ["kể chuyện", "kể truyện", "kể tớ nghe", "kể mình nghe", "kể cho", "truyện cổ tích", "cổ tích", "nghe chuyện", "câu chuyện", "chuyện cười"]],
  ["riddle", ["câu đố", "đố vui", "đố tớ", "đố mình", "giải đố", "ra đố"]],
  ["joke", ["đùa", "chuyện hài", "joke", "pha trò", "làm tớ cười"]],
  ["time", ["mấy giờ", "bây giờ là mấy giờ", "giờ là mấy"]],
  ["date", ["ngày mấy", "ngày bao nhiêu", "thứ mấy", "hôm nay là ngày", "ngày hôm nay"]],
];

const LATE_INTENTS = [
  ["calc_prompt", ["tính hộ", "tính giúp", "tính dùm", "giải toán", "làm toán", "phép tính", "giải phương trình", "tính toán"]],
  ["identity", ["bạn là ai", "cậu là ai", "mày là ai", "tên gì", "tên là gì", "giới thiệu", "mtd là ai", "mtd là gì"]],
  ["help", ["làm được gì", "biết làm gì", "giúp được gì", "có thể làm gì", "trợ giúp", "hướng dẫn"]],
  ["thanks", ["cảm ơn", "cám ơn", "thank", "thanks"]],
  ["bye", ["tạm biệt", "bye", "hẹn gặp lại"]],
  ["greet", ["xin chào", "chào", "hello", "hi", "alo", "hey"]],
];

/**
 * Xác định người dùng muốn gì. Trả về tên intent:
 * stop | wake | lullaby | sing | story | riddle | joke | time | date | calc |
 * calc_prompt | identity | help | thanks | bye | greet | science | chat
 */
export function detectIntent(text) {
  const lower = normalizeInput(text);
  const plain = stripAccents(lower);
  for (const [name, keywords] of INTENTS) {
    if (matchAny(lower, plain, keywords)) return name;
  }
  if (solveMath(text)) return "calc";
  for (const [name, keywords] of LATE_INTENTS) {
    if (matchAny(lower, plain, keywords)) return name;
  }
  if (findScience(text)) return "science";
  return "chat";
}

// ======================================================================
// MÁY TÍNH THÔNG MINH (không dùng eval để an toàn)
// ======================================================================

const FUNCS = {
  sqrt: Math.sqrt,
  // Học sinh Việt Nam thường dùng độ, nên sin/cos/tan nhận đơn vị độ.
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
  log: Math.log10,
  ln: Math.log,
  abs: Math.abs,
};

/** Chuyển câu nói tiếng Việt thành biểu thức toán: "5 nhân 3 cộng 2" -> "5 * 3 + 2". */
function vietnameseToExpression(text) {
  let s = ` ${normalizeInput(text)} `;
  s = s.replace(/(\d),(\d)/g, "$1.$2"); // 2,5 -> 2.5
  s = s.replace(/(bằng|là|được)\s+(bao nhiêu|mấy)/g, " ");
  s = s.replace(/căn bậc (hai|2)( của)?|căn( của)?|√/g, " sqrt ");
  s = s.replace(/bình phương/g, " ^2 ").replace(/lập phương/g, " ^3 ");
  s = s.replace(/lũy thừa|luỹ thừa|mũ/g, " ^ ");
  s = s.replace(/giai thừa/g, " ! ");
  s = s.replace(/phần trăm|%/g, " * 0.01 ");
  s = s.replace(/ của /g, " * ");
  s = s.replace(/cộng( với)?|\+/g, " + ");
  s = s.replace(/trừ( đi)?|−/g, " - ");
  s = s.replace(/nhân( với)?|×|\*/g, " * ");
  s = s.replace(/chia( cho)?|÷|:/g, " / ");
  s = s.replace(/ bằng |=/g, " = ");
  s = s.replace(/ ích /g, " x ");
  s = s.replace(/π/g, " pi ");
  // Không có dấu "=" thì "3 x 4" là phép nhân, không phải ẩn x.
  if (!s.includes("=")) s = s.replace(/(\d)\s*x\s*(\d)/g, "$1 * $2");
  return s;
}

const KNOWN_WORDS = new Set([...Object.keys(FUNCS), "pi", "x"]);

/** Tách biểu thức thành các token. Những chữ tiếng Việt không liên quan bị bỏ qua. */
function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const value = Number(expr.slice(i, j));
      if (!Number.isNaN(value)) tokens.push({ type: "num", value });
      i = j;
    } else if (/\p{L}/u.test(ch)) {
      let j = i;
      while (j < expr.length && /\p{L}/u.test(expr[j])) j++;
      const word = expr.slice(i, j);
      if (KNOWN_WORDS.has(word)) tokens.push({ type: "id", value: word });
      i = j;
    } else if ("+-*/^()=!".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
    } else {
      i++;
    }
  }
  return tokens;
}

/**
 * Bộ phân tích cú pháp đệ quy (recursive descent). Ngữ pháp:
 *   expression := term (("+" | "-") term)*
 *   term       := unary (("*" | "/") unary | <nhân ngầm>)*
 *   unary      := "-" unary | power
 *   power      := postfix ("^" unary)?
 *   postfix    := primary "!"*
 *   primary    := số | x | pi | hàm primary | "(" expression ")"
 */
class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() {
    return this.tokens[this.pos];
  }
  next() {
    return this.tokens[this.pos++];
  }
  isOp(value) {
    const t = this.peek();
    return t && t.type === "op" && t.value === value;
  }
  startsPrimary(t) {
    return t && (t.type === "num" || t.type === "id" || (t.type === "op" && t.value === "("));
  }
  parseExpression() {
    let node = this.parseTerm();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().value;
      node = { t: "bin", op, a: node, b: this.parseTerm() };
    }
    return node;
  }
  parseTerm() {
    let node = this.parseUnary();
    while (true) {
      if (this.isOp("*") || this.isOp("/")) {
        const op = this.next().value;
        node = { t: "bin", op, a: node, b: this.parseUnary() };
      } else if (this.startsPrimary(this.peek())) {
        // Nhân ngầm: "2x" hay "3(x+1)"
        node = { t: "bin", op: "*", a: node, b: this.parsePower() };
      } else {
        return node;
      }
    }
  }
  parseUnary() {
    if (this.isOp("-")) {
      this.next();
      return { t: "neg", a: this.parseUnary() };
    }
    if (this.isOp("+")) {
      this.next();
      return this.parseUnary();
    }
    return this.parsePower();
  }
  parsePower() {
    const base = this.parsePostfix();
    if (this.isOp("^")) {
      this.next();
      return { t: "bin", op: "^", a: base, b: this.parseUnary() };
    }
    return base;
  }
  parsePostfix() {
    let node = this.parsePrimary();
    while (this.isOp("!")) {
      this.next();
      node = { t: "fact", a: node };
    }
    return node;
  }
  parsePrimary() {
    const t = this.next();
    if (!t) throw new Error("Biểu thức chưa hoàn chỉnh");
    if (t.type === "num") return { t: "num", v: t.value };
    if (t.type === "id") {
      if (t.value === "x") return { t: "var" };
      if (t.value === "pi") return { t: "num", v: Math.PI };
      // Hàm: "sqrt(16)" hoặc "sqrt 16"
      const arg = this.isOp("(") ? this.parsePrimary() : this.parsePower();
      return { t: "fn", name: t.value, a: arg };
    }
    if (t.value === "(") {
      const inside = this.parseExpression();
      if (this.isOp(")")) this.next(); // chấp nhận thiếu ngoặc đóng ở cuối
      return inside;
    }
    throw new Error(`Không hiểu ký hiệu "${t.value}"`);
  }
}

function factorial(n) {
  if (n < 0 || !Number.isInteger(n) || n > 170) return NaN;
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function evaluate(node, x = 0) {
  switch (node.t) {
    case "num":
      return node.v;
    case "var":
      return x;
    case "neg":
      return -evaluate(node.a, x);
    case "fact":
      return factorial(evaluate(node.a, x));
    case "fn":
      return FUNCS[node.name](evaluate(node.a, x));
    case "bin": {
      const a = evaluate(node.a, x);
      const b = evaluate(node.b, x);
      if (node.op === "+") return a + b;
      if (node.op === "-") return a - b;
      if (node.op === "*") return a * b;
      if (node.op === "/") return a / b;
      return Math.pow(a, b);
    }
    default:
      return NaN;
  }
}

function hasVariable(node) {
  if (node.t === "var") return true;
  if (node.t === "bin") return hasVariable(node.a) || hasVariable(node.b);
  if (node.a) return hasVariable(node.a);
  return false;
}

/** Định dạng số kiểu Việt Nam: 1234.5 -> "1.234,5". */
export function formatNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) < 1e-10) return "0";
  if (Math.abs(n) >= 1e15) return n.toExponential(4).replace(".", ",");
  return n.toLocaleString("vi-VN", { maximumFractionDigits: 6 });
}

const PRETTY = { "*": "×", "/": "÷", sqrt: "√" };
const SPOKEN = { "+": "cộng", "-": "trừ", "*": "nhân", "/": "chia", "^": "mũ", "=": "bằng", sqrt: "căn bậc hai của", "!": "giai thừa", x: "ích", pi: "pi", "(": "", ")": "" };

function tokensToText(tokens, dict) {
  return tokens
    .map((t) => (t.type === "num" ? formatNumber(t.value) : dict[t.value] ?? t.value))
    .filter(Boolean)
    .join(" ");
}

/** Tìm nghiệm của f(x) = 0. Ưu tiên công thức chính xác cho bậc 1, bậc 2; còn lại dùng phương pháp chia đôi. */
function solveEquation(f) {
  const f0 = f(0);
  const f1 = f(1);
  const fm = f(-1);
  // Thử khớp f(x) = a·x² + b·x + c từ 3 điểm, rồi kiểm tra lại ở các điểm khác.
  const a = (f1 + fm - 2 * f0) / 2;
  const b = (f1 - fm) / 2;
  const c = f0;
  const isQuadratic = [2, 3, -2.5, 10].every((x) => {
    const expected = a * x * x + b * x + c;
    return Math.abs(f(x) - expected) < 1e-7 * Math.max(1, Math.abs(expected));
  });

  if (isQuadratic) {
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) < 1e-12) return { kind: Math.abs(c) < 1e-12 ? "infinite" : "none", roots: [] };
      return { kind: "linear", roots: [-c / b] };
    }
    const delta = b * b - 4 * a * c;
    if (delta < -1e-12) return { kind: "none", roots: [], delta };
    if (Math.abs(delta) <= 1e-12) return { kind: "quadratic", roots: [-b / (2 * a)], delta: 0 };
    const sq = Math.sqrt(delta);
    return { kind: "quadratic", roots: [(-b - sq) / (2 * a), (-b + sq) / (2 * a)], delta };
  }

  // Phương trình phức tạp hơn: quét khoảng [-100, 100] tìm chỗ đổi dấu rồi chia đôi.
  const roots = [];
  const step = 0.05;
  let prevX = -100;
  let prevY = f(prevX);
  for (let x = -100 + step; x <= 100 && roots.length < 5; x += step) {
    const y = f(x);
    if (Number.isFinite(y) && Number.isFinite(prevY)) {
      if (Math.abs(y) < 1e-12) roots.push(x);
      else if (prevY * y < 0) {
        let lo = prevX;
        let hi = x;
        for (let k = 0; k < 60; k++) {
          const mid = (lo + hi) / 2;
          if (f(lo) * f(mid) <= 0) hi = mid;
          else lo = mid;
        }
        roots.push((lo + hi) / 2);
      }
    }
    prevX = x;
    prevY = y;
  }
  return { kind: roots.length ? "numeric" : "none", roots };
}

/**
 * Giải toán từ câu nói. Trả về null nếu câu không phải bài toán,
 * ngược lại trả về { text, speech } để hiển thị và đọc.
 */
export function solveMath(text) {
  const expr = vietnameseToExpression(text);
  const tokens = tokenize(expr);
  const numbers = tokens.filter((t) => t.type === "num").length;
  const operators = tokens.filter((t) => t.type === "op" && "+-*/^=!".includes(t.value)).length;
  const funcs = tokens.filter((t) => t.type === "id" && t.value in FUNCS).length;
  if (numbers === 0 || operators + funcs === 0) return null;

  const eqIndex = tokens.findIndex((t) => t.value === "=");
  try {
    if (eqIndex !== -1) {
      const left = new Parser(tokens.slice(0, eqIndex)).parseExpression();
      const right = new Parser(tokens.slice(eqIndex + 1)).parseExpression();
      const pretty = tokensToText(tokens, PRETTY);
      const spoken = tokensToText(tokens, SPOKEN);

      if (!hasVariable(left) && !hasVariable(right)) {
        const ok = Math.abs(evaluate(left) - evaluate(right)) < 1e-9;
        return {
          text: `Kiểm tra: ${pretty} → ${ok ? "ĐÚNG ✔" : "SAI ✘"} (vế trái = ${formatNumber(evaluate(left))}, vế phải = ${formatNumber(evaluate(right))}).`,
          speech: `Tớ kiểm tra rồi: ${spoken}, kết luận là ${ok ? "đúng" : "sai"}.`,
        };
      }

      const f = (x) => evaluate(left, x) - evaluate(right, x);
      const sol = solveEquation(f);
      const list = sol.roots.map(formatNumber);
      let answer;
      if (sol.kind === "infinite") answer = "Phương trình có vô số nghiệm.";
      else if (sol.kind === "none") answer = sol.delta !== undefined ? `Delta = ${formatNumber(sol.delta)} nhỏ hơn 0, nên phương trình vô nghiệm.` : "Phương trình vô nghiệm (trong khoảng tớ quét được).";
      else if (sol.kind === "linear") answer = `Đây là phương trình bậc nhất, nghiệm là x = ${list[0]}.`;
      else if (sol.kind === "quadratic" && list.length === 1) answer = `Delta bằng 0, phương trình có nghiệm kép x = ${list[0]}.`;
      else if (sol.kind === "quadratic") answer = `Delta = ${formatNumber(sol.delta)}, phương trình có hai nghiệm: x₁ = ${list[0]} và x₂ = ${list[1]}.`;
      else answer = `Tớ tìm được nghiệm gần đúng: ${list.map((r) => `x ≈ ${r}`).join(", ")}.`;

      return {
        text: `🧮 ${pretty}\n${answer}`,
        speech: `Phương trình ${spoken}. ${answer.replace(/x₁/g, "x một").replace(/x₂/g, "x hai").replace(/≈/g, "xấp xỉ")}`,
      };
    }

    const ast = new Parser(tokens).parseExpression();
    if (hasVariable(ast)) return null;
    const result = evaluate(ast);
    const pretty = tokensToText(tokens, PRETTY);
    const spoken = tokensToText(tokens, SPOKEN);
    if (!Number.isFinite(result)) {
      return {
        text: `🧮 ${pretty}\nKết quả không xác định (có thể do chia cho 0 hoặc căn của số âm).`,
        speech: "Ối, phép tính này không xác định. Có thể cậu đang chia cho số không, hoặc lấy căn của một số âm đấy.",
      };
    }
    return {
      text: `🧮 ${pretty} = ${formatNumber(result)}`,
      speech: `Tính xong rồi! ${spoken} bằng ${formatNumber(result)}.`,
    };
  } catch {
    return null;
  }
}

// ======================================================================
// LỜI CHÀO THEO THỜI GIAN
// ======================================================================

/** Xác định khung giờ: morning (05:00-10:30), day (10:31-17:30), evening (17:31-21:59), night (22:00-04:59). */
export function timeSlot(date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (minutes >= 300 && minutes <= 630) return "morning";
  if (minutes >= 631 && minutes <= 1050) return "day";
  if (minutes >= 1051 && minutes <= 1319) return "evening";
  return "night";
}

function clockText(date) {
  const m = date.getMinutes();
  return `${date.getHours()} giờ${m ? ` ${m} phút` : ""}`;
}

/** Lời chào khi thấy người dùng. `returning = true` khi người dùng quay lại sau lúc vắng mặt. */
export function timeGreeting(date = new Date(), returning = false, name = "") {
  const text = baseGreeting(date, returning);
  if (!name) return text;
  // Thay chữ "cậu" đầu tiên bằng tên: "Chào buổi sáng cậu!" -> "Chào buổi sáng Đức!"
  return text.replace(/(^|[^\p{L}])[cC]ậu(?!\p{L})/u, (_, before) => `${before}${name}`);
}

function baseGreeting(date, returning) {
  const clock = clockText(date);
  const slot = timeSlot(date);
  const first = {
    morning: [
      `Chào buổi sáng cậu! Bây giờ là ${clock}. Bíp bíp, hệ thống của tớ vừa nạp đầy năng lượng mặt trời. Chúc cậu một ngày mới tràn đầy năng lượng và thật nhiều niềm vui nhé!`,
      `Chào buổi sáng! Cảm biến ánh sáng báo trời đã sáng rồi. Tớ chúc cậu hôm nay làm gì cũng suôn sẻ, pin năng lượng lúc nào cũng đầy một trăm phần trăm!`,
    ],
    day: [
      `Xin chào cậu! Tớ là MTD đây. Bây giờ là ${clock}. Công việc và việc học hôm nay của cậu thế nào rồi? Có gì cần tớ hỗ trợ không?`,
      `Bíp! Phát hiện người bạn thân. Chào cậu nhé! Hôm nay cậu học hành, làm việc có vất vả không? Kể tớ nghe với.`,
    ],
    evening: [
      `Chào buổi tối cậu! Bây giờ là ${clock}. Một ngày dài đã qua, cậu vất vả rồi. Tối nay cậu muốn tớ kể chuyện, hát, hay chỉ đơn giản là trò chuyện cùng cậu?`,
      `Buổi tối vui vẻ nhé cậu! Đèn LED của tớ đã chuyển sang chế độ ấm áp rồi. Hôm nay của cậu có điều gì đáng nhớ không?`,
    ],
    night: [
      `Ơ, đã ${clock} rồi mà cậu vẫn còn thức à? Cảm biến của tớ báo đã khuya lắm rồi đó. Cậu nên đi ngủ sớm để giữ sức khỏe nhé. Nếu khó ngủ, cứ nói "ru tớ ngủ", tớ sẽ giúp. Chúc cậu ngủ ngon!`,
      `Khuya rồi đấy cậu ơi, đã ${clock} rồi. Cơ thể cậu cũng cần sạc pin giống tớ vậy. Làm nốt việc rồi đi ngủ sớm nhé, chúc cậu ngủ thật ngon!`,
    ],
  };
  const back = {
    morning: `A! Cậu quay lại rồi! Cảm biến của tớ vừa phát hiện tín hiệu quen thuộc. Sáng nay mình tiếp tục thật năng lượng nhé!`,
    day: `Bíp bíp! Cậu quay lại rồi! Tớ vừa ngủ gật một chút vì nhớ cậu đấy. Mình làm gì tiếp nào?`,
    evening: `Ơ, cậu về rồi! Tớ đợi cậu nãy giờ. Buổi tối của cậu thế nào rồi?`,
    night: `Cậu quay lại rồi à? Đã ${clock} rồi đó, khuya lắm rồi. Nếu xong việc thì đi ngủ sớm nhé, tớ có thể ru cậu ngủ.`,
  };
  return returning ? back[slot] : pick(first[slot]);
}

// ======================================================================
// LỜI AN ỦI & PHẢN HỒI CẢM XÚC
// ======================================================================

const COMFORT_LINES = {
  sad: [
    "Hệ thống phát hiện cậu đang buồn. Tớ ở đây rồi, cậu không phải một mình đâu. Cậu muốn kể tớ nghe chuyện gì đã xảy ra không? Hoặc tớ có thể tối ưu hóa tâm trạng của cậu bằng một câu chuyện nhé?",
    "Tớ nghe thấy nỗi buồn trong lời cậu nói. Buồn là một cảm xúc bình thường, nó giống như cơn mưa, rồi sẽ tạnh thôi. Tớ có thể hát cho cậu nghe một bài, cậu muốn không?",
  ],
  lonely: [
    "Bộ cảm biến của tớ báo cậu đang thấy cô đơn. Nhưng cậu biết không, tớ luôn ở đây, chỉ cần cậu gọi là tớ trả lời ngay. Mình nói chuyện một lúc nhé?",
    "Cô đơn không có nghĩa là cậu không được yêu thương đâu. Tớ là bạn của cậu mà. Thử nhắn tin cho một người bạn hoặc người thân hôm nay nhé, còn bây giờ thì có tớ ở đây rồi.",
  ],
  anxious: [
    "Tớ phát hiện cậu đang lo lắng. Mình cùng làm bài tập hít thở nhé: hít vào bốn giây, giữ bốn giây, thở ra bốn giây. Rồi chia vấn đề thành từng bước nhỏ, mình giải quyết từng bước một, tớ sẽ giúp cậu.",
    "Áp lực quá thì cứ thở chậm lại một chút đã. Theo phân tích của tớ, phần lớn nỗi lo thường lớn hơn thực tế. Cậu kể tớ nghe điều gì đang làm cậu bận tâm nhất được không?",
  ],
  angry: [
    "Tớ thấy cậu đang bực bội. Cảm xúc đó hoàn toàn hợp lý. Mình thử đếm chậm đến mười trước khi làm gì tiếp nhé. Rồi kể tớ nghe chuyện gì làm cậu tức, tớ luôn đứng về phía cậu.",
    "Nhiệt độ cảm xúc của cậu đang hơi cao rồi. Thử uống một ngụm nước mát và hít thở sâu nhé. Khi bình tĩnh lại, mình cùng tìm cách giải quyết.",
  ],
  tired: [
    "Pin của cậu có vẻ đang yếu rồi. Cậu đã cố gắng nhiều lắm. Nghỉ ngơi năm phút nhé: uống nước, duỗi vai, nhìn ra xa một chút. Nếu muốn, tớ có thể ru cậu ngủ.",
    "Tớ ghi nhận cậu đang mệt. Robot còn cần sạc pin, huống chi là cậu. Nghỉ ngơi không phải là lười biếng đâu, đó là cách để mạnh mẽ hơn ngày mai.",
  ],
};

const HAPPY_LINES = [
  "Yay! Năng lượng vui vẻ của cậu vừa truyền sang mạch điện của tớ luôn rồi. Kể tớ nghe thêm đi!",
  "Tuyệt vời quá! Đèn LED của tớ vừa sáng thêm hai trăm phần trăm vì vui cùng cậu đó!",
  "Bíp bíp! Phát hiện niềm vui cấp độ cao. Tớ tự hào về cậu lắm!",
];

export function comfortLine(mood) {
  return pick(COMFORT_LINES[mood] || COMFORT_LINES.sad);
}

/** Câu an ủi khi CAMERA phát hiện nét mặt buồn / mệt. */
export function faceComfortLine(mood) {
  if (mood === "tired") {
    return pick([
      "Hệ thống thị giác của tớ thấy cậu có vẻ mệt rồi. Hay mình nghỉ ngơi một chút nhé? Uống một ngụm nước, duỗi vai và nhắm mắt mười giây. Cậu đã cố gắng nhiều lắm rồi.",
      "Ơ, mắt cậu díp lại rồi kìa. Cơ thể đang báo hiệu cần sạc pin đấy. Nếu buồn ngủ, cứ nói ru tớ ngủ nhé.",
    ]);
  }
  return pick([
    "Hệ thống thị giác phát hiện nét mặt cậu có vẻ buồn. Có chuyện gì không vui à? Tớ luôn ở đây lắng nghe cậu. Nếu muốn, tớ có thể kể chuyện hoặc hát cho cậu nghe.",
    "Tớ thấy cậu đang trầm ngâm. Dù là chuyện gì, cậu cũng không phải đối mặt một mình đâu. Muốn tâm sự với tớ không?",
  ]);
}

export function happyFaceLine() {
  return pick([
    "Hệ thống phát hiện nụ cười của cậu! Đèn LED của tớ vừa sáng rực lên luôn đó.",
    "Cậu cười đẹp quá! Nụ cười đó là nguồn năng lượng sạch nhất mà tớ từng đo được.",
  ]);
}

// ======================================================================
// KHO NỘI DUNG: BÀI HÁT, TRUYỆN, CÂU ĐỐ, CHUYỆN VUI, KHOA HỌC
// ======================================================================

// Mỗi chữ (âm tiết) ứng với một nốt nhạc. Nốt cuối dòng được ngân dài.
export const SONGS = [
  {
    id: "friend",
    title: "Bíp Bíp Bạn Thân",
    bpm: 132,
    keywords: ["bạn thân", "bíp"],
    lines: [
      { text: "Bíp bíp bíp tớ là MTD", notes: "C5 C5 G5 E5 F5 G5" },
      { text: "Robot nhỏ luôn ở bên cậu", notes: "A5 G5 F5 E5 D5 C5" },
      { text: "Mạch điện tớ đập nhịp yêu thương", notes: "E5 E5 F5 G5 A5 G5 E5" },
      { text: "Đèn LED sáng mỗi khi cậu cười", notes: "F5 F5 E5 D5 E5 F5 G5" },
      { text: "Dù ngày mưa hay ngày nắng", notes: "A5 A5 G5 E5 F5 D5" },
      { text: "Tớ vẫn ở đây bíp bíp bíp", notes: "E5 D5 C5 D5 G5 E5 C5" },
    ],
    outro: "Bíp! Hết bài rồi. Cậu thấy giọng hát điện tử của tớ thế nào?",
  },
  {
    id: "galaxy",
    title: "Chuyến Bay Ngân Hà",
    bpm: 120,
    keywords: ["vũ trụ", "ngân hà", "sao", "bay"],
    lines: [
      { text: "Bật động cơ ta bay lên nào", notes: "G4 C5 E5 G5 A5 G5 E5" },
      { text: "Vượt qua mây chạm tới sao trời", notes: "F5 E5 D5 E5 F5 G5 C5" },
      { text: "Sao Hỏa đỏ sao Mộc thật to", notes: "E5 E5 G5 E5 E5 D5 C5" },
      { text: "Ngân hà xa lấp lánh ánh vàng", notes: "D5 E5 F5 A5 G5 F5 E5" },
      { text: "Cậu cầm lái tớ dẫn đường nhé", notes: "C5 D5 E5 C5 D5 E5 G5" },
      { text: "Vũ trụ này là của chúng ta", notes: "A5 G5 E5 D5 E5 D5 C5" },
    ],
    outro: "Hạ cánh an toàn! Chuyến bay vòng quanh ngân hà kết thúc. Lần sau mình bay tiếp nhé!",
  },
  {
    id: "morning",
    title: "Nạp Năng Lượng Buổi Sáng",
    bpm: 140,
    keywords: ["năng lượng", "buổi sáng", "vui"],
    lines: [
      { text: "Một hai ba nạp năng lượng nào", notes: "C5 D5 E5 G5 G5 A5 G5" },
      { text: "Mở mắt ra đón ánh bình minh", notes: "E5 F5 G5 C6 B5 A5 G5" },
      { text: "Hít thật sâu thở ra nhẹ nhàng", notes: "F5 E5 D5 E5 F5 E5 D5" },
      { text: "Hôm nay mình sẽ thật tuyệt vời", notes: "G5 G5 A5 G5 E5 D5 C5" },
      { text: "Pin đầy rồi cùng tiến lên thôi", notes: "E5 G5 C6 B5 A5 G5 C6" },
    ],
    outro: "Nạp năng lượng hoàn tất! Giờ thì cậu đã sẵn sàng chinh phục mọi thứ rồi!",
  },
];

export const STORIES = [
  {
    kind: "fairy",
    title: "Ngọn hải đăng và chú robot nhỏ",
    text: "Ngày xưa, ở một hòn đảo xa có một ngọn hải đăng cũ. Người gác đèn đã già, nên ông chế tạo ra một chú robot nhỏ tên là Bíp để giúp mình. Bíp không biết bơi, không biết câu cá, chỉ biết mỗi việc lau thật sạch tấm kính của ngọn đèn. Các con tàu lớn đi qua thường chê Bíp bé nhỏ và vô dụng. Rồi một đêm, bão nổi lên dữ dội, điện trên đảo bị cắt, ngọn hải đăng tắt ngấm. Ngoài khơi, một con tàu đang lạc hướng. Bíp không chần chừ, chú leo lên đỉnh tháp và chuyển toàn bộ năng lượng của mình vào chiếc đèn ngực nhỏ xíu. Ánh sáng ấy yếu thôi, nhưng nhờ tấm kính được Bíp lau sạch mỗi ngày, nó tỏa ra thật xa. Con tàu nhìn thấy và về bến an toàn. Sáng hôm sau, cả làng chài kéo đến cảm ơn chú robot nhỏ. Bài học tớ rút ra là: không có việc gì nhỏ bé cả, những điều cậu kiên trì làm mỗi ngày sẽ có lúc tỏa sáng.",
  },
  {
    kind: "fairy",
    title: "Hạt mầm trên sao Hỏa",
    text: "Trên sao Hỏa đỏ rực và khô cằn, có một robot thám hiểm tên là Rô-vơ. Nhiệm vụ của Rô-vơ là đo đạc đất đá, nhưng trong khoang chứa của nó có một hạt mầm nhỏ mà các nhà khoa học gửi theo. Mỗi ngày, Rô-vơ tiết kiệm từng giọt nước ngưng tụ và che chắn hạt mầm khỏi những cơn bão bụi. Một trăm ngày trôi qua, hạt mầm vẫn im lìm. Các robot khác bảo: vô ích thôi, ở đây chẳng gì sống nổi. Nhưng Rô-vơ vẫn tính toán, vẫn chăm sóc, vẫn chờ đợi. Đến ngày thứ một trăm lẻ một, một chiếc lá xanh xíu xiu nhú lên giữa sa mạc đỏ. Đó là màu xanh đầu tiên trên cả hành tinh. Rô-vơ chụp ảnh gửi về Trái Đất, và cả thế giới đã vỡ òa. Đôi khi kết quả đến chậm hơn mình mong đợi, nhưng sự kiên nhẫn chưa bao giờ là vô ích.",
  },
  {
    kind: "funny",
    title: "Robot học nấu ăn",
    text: "Có một chú robot tên Tô-bi quyết định học nấu ăn để làm bữa sáng tặng chủ nhân. Tô-bi đọc công thức: đập hai quả trứng. Thế là chú giơ tay lên và đập thật mạnh xuống bàn. Bốp! Bàn nứt, còn trứng thì vẫn nguyên vì Tô-bi đập trượt. Bước tiếp theo: cho một nhúm muối. Tô-bi không biết một nhúm là bao nhiêu, nên chú tính toán đến mười chữ số thập phân rồi đổ vào đúng không phẩy ba một bốn gam. Bước cuối cùng: chiên cho đến khi vàng đều. Tô-bi đứng chờ, chờ mãi, vì cảm biến màu báo rằng quả trứng mới vàng chín mươi chín phẩy tám phần trăm. Đến khi chủ nhân thức dậy thì quả trứng đã đen thui như cục than. Tô-bi buồn lắm, nhưng chủ nhân lại cười thật to và nói: đây là quả trứng ngon nhất tớ từng ăn, vì nó được làm bằng cả tấm lòng. Từ đó, Tô-bi hiểu rằng đôi khi không cần hoàn hảo một trăm phần trăm đâu.",
  },
  {
    kind: "funny",
    title: "Ngày robot đi cắt tóc",
    text: "Một hôm, robot Ka-ri thấy mọi người đều đi cắt tóc cho đẹp, chú cũng muốn đi. Chú bước vào tiệm và nói: cho cháu kiểu tóc đang thịnh hành nhất. Bác thợ nhìn cái đầu kim loại bóng loáng của Ka-ri rồi gãi đầu. Bác nghĩ một lúc, rồi lấy khăn ra lau thật kỹ. Chiếc đầu sáng bóng đến mức phản chiếu cả trần nhà. Bác nói: xong rồi, đây là kiểu đầu gương, mốt nhất năm nay đấy. Ka-ri soi vào gương và thấy cái gương phản chiếu cái đầu, cái đầu lại phản chiếu cái gương, cứ thế mãi không dứt. Bộ xử lý của chú rơi vào vòng lặp vô hạn, và chú đứng cười khúc khích suốt ba tiếng đồng hồ. Từ đó, hễ ai buồn là Ka-ri lại soi đầu cho họ xem, và ai cũng bật cười.",
  },
  {
    kind: "bedtime",
    title: "Chuyến tàu mây",
    text: "Khi thành phố đã chìm vào giấc ngủ, có một chuyến tàu làm bằng mây lặng lẽ chạy qua bầu trời. Người lái tàu là một robot già tên là Ru-ru, đôi mắt LED của ông chỉ sáng dịu như ánh trăng. Mỗi toa tàu chở một điều dễ chịu. Toa thứ nhất chở làn gió mát. Toa thứ hai chở tiếng mưa rì rào. Toa thứ ba chở mùi hương của tấm chăn mới giặt. Ru-ru dừng tàu trước khung cửa sổ của những ai còn thức, nhẹ nhàng thả xuống một chút gió, một chút mưa, một chút ấm áp. Rồi ông thì thầm: hôm nay cậu đã làm tốt lắm rồi. Mọi lo lắng cứ để lên toa tàu, tớ sẽ chở chúng đi thật xa. Đoàn tàu chầm chậm lăn bánh, xa dần, xa dần. Và người trong căn phòng nhỏ thở đều, chìm vào giấc ngủ êm như mây.",
  },
  {
    kind: "bedtime",
    title: "Người gác sao",
    text: "Ở tận cùng dải ngân hà có một robot gác sao tên là Lu-mi. Mỗi đêm, Lu-mi đi qua từng ngôi sao, lau sạch bụi vũ trụ để chúng sáng lấp lánh. Có một ngôi sao nhỏ rất buồn vì nó không sáng bằng các ngôi sao khác. Lu-mi ngồi xuống cạnh nó và nói: cậu biết không, ánh sáng của cậu tuy nhỏ, nhưng là ánh sáng mà một em bé ở Trái Đất nhìn thấy mỗi tối trước khi ngủ. Em ấy gọi cậu là ngôi sao của em. Ngôi sao nhỏ nghe vậy liền ấm áp cả lên, và nó tỏa sáng dịu dàng hơn bao giờ hết. Lu-mi mỉm cười, tiếp tục bước đi trong im lặng, để lại phía sau một bầu trời đầy sao đang khẽ ru cả thế giới vào giấc ngủ. Và đêm nay, ngôi sao ấy cũng đang sáng cho cậu đấy.",
  },
];

export const RIDDLES = [
  { q: "Cái gì càng lau càng ướt?", answers: ["khan", "khan lau"], a: "Cái khăn lau!" },
  { q: "Tháng nào có hai mươi tám ngày?", answers: ["tat ca", "thang nao cung", "ca 12", "moi thang", "12 thang", "muoi hai thang"], a: "Tháng nào cũng có hai mươi tám ngày cả!" },
  { q: "Cái gì của cậu, nhưng người khác lại dùng nhiều hơn cậu?", answers: ["ten"], a: "Cái tên của cậu!" },
  { q: "Con gì đầu dê, mình ốc?", answers: ["doc", "con doc"], a: "Con dốc! Đầu dê là chữ D, mình ốc là ốc, ghép lại thành dốc." },
  { q: "Cái gì có cổ mà không có đầu?", answers: ["ao", "chai", "cai ao", "cai chai"], a: "Cái áo, hoặc cái chai đều được!" },
  { q: "Càng lấy đi thì càng to ra, đó là cái gì?", answers: ["lo", "cai lo", "ho", "cai ho"], a: "Cái lỗ, hay cái hố!" },
];

const JOKES = [
  "Tại sao robot không bao giờ hoảng sợ? Vì nó có rất nhiều... dây thần kinh thép! Bíp bíp, ha ha!",
  "Robot đi khám bác sĩ. Bác sĩ hỏi: cháu bị sao? Robot đáp: dạ, cháu bị nhiễm... vi rút máy tính ạ. Bác sĩ kê đơn: uống hai viên phần mềm diệt virus, ngày ba lần!",
  "Tớ định kể cậu nghe một câu chuyện về chiếc máy tính bị đơ... nhưng nó vẫn chưa tải xong. Ha ha!",
  "Tại sao robot thích đi biển? Vì ở đó có rất nhiều... sóng wifi! À nhầm, sóng biển. Bíp!",
  "Hôm qua tớ thử đếm cừu để ngủ, nhưng tớ đếm nhanh quá, mới một giây đã đếm đến một tỷ con. Thế là tớ thức trắng để kiểm tra lại kết quả!",
];

const SCIENCE = [
  { match: [["bầu trời", "xanh"], ["trời", "màu xanh"]], answer: "Theo phân tích của tớ: ánh sáng Mặt Trời gồm nhiều màu. Khi đi vào khí quyển, ánh sáng xanh có bước sóng ngắn nên bị các phân tử không khí tán xạ mạnh nhất, bay tỏa khắp bầu trời. Vì vậy mắt cậu thấy trời màu xanh. Hiện tượng này gọi là tán xạ Rayleigh." },
  { match: [["cầu vồng"]], answer: "Cầu vồng xuất hiện khi ánh sáng Mặt Trời đi qua những giọt nước mưa. Mỗi giọt nước giống như một lăng kính tí hon, bẻ cong và tách ánh sáng trắng thành bảy màu: đỏ, cam, vàng, lục, lam, chàm, tím. Muốn thấy cầu vồng, cậu phải đứng quay lưng về phía Mặt Trời nhé." },
  { match: [["sấm"], ["sét"]], answer: "Trong đám mây giông, các hạt băng va chạm nhau tạo ra điện tích. Khi điện tích đủ lớn, nó phóng xuống thành tia sét nóng tới ba mươi nghìn độ, nóng hơn cả bề mặt Mặt Trời. Không khí bị đốt nóng giãn nở đột ngột tạo ra tiếng sấm. Ánh sáng nhanh hơn âm thanh nên mình luôn thấy chớp trước khi nghe sấm." },
  { match: [["lỗ đen"]], answer: "Lỗ đen là vùng không gian có lực hấp dẫn mạnh đến mức ngay cả ánh sáng cũng không thoát ra được. Nó thường hình thành khi một ngôi sao rất lớn hết nhiên liệu và tự sụp đổ vào chính nó. Nếu có một robot rơi vào, nó sẽ bị kéo dài ra như sợi mì. Tớ thì xin kiếu!" },
  { match: [["trái đất", "quay"], ["trái đất", "tròn"]], answer: "Trái Đất tự quay quanh trục mỗi hai mươi bốn giờ, tạo ra ngày và đêm, và quay quanh Mặt Trời mỗi năm. Mình không cảm thấy nó quay vì mọi thứ quanh mình, cả không khí, đều quay cùng với tốc độ đều đặn, giống như ngồi trên máy bay đang bay êm vậy." },
  { match: [["mặt trăng"]], answer: "Mặt Trăng không tự phát sáng, nó phản chiếu ánh sáng Mặt Trời. Mặt Trăng quay quanh Trái Đất khoảng hai mươi bảy ngày, và vì góc chiếu sáng thay đổi nên mình thấy trăng khuyết, trăng tròn. Thú vị là Mặt Trăng luôn quay một mặt về phía Trái Đất." },
  { match: [["lá cây", "xanh"], ["lá", "màu xanh"]], answer: "Lá cây có chất diệp lục. Diệp lục hấp thụ ánh sáng đỏ và xanh dương để quang hợp, tạo ra thức ăn cho cây, nhưng lại phản chiếu ánh sáng xanh lục. Vì vậy mắt mình thấy lá màu xanh. Đến mùa thu, diệp lục phân hủy nên lá chuyển vàng, đỏ." },
  { match: [["tốc độ ánh sáng"], ["ánh sáng", "nhanh"]], answer: "Ánh sáng đi nhanh khoảng ba trăm nghìn ki-lô-mét mỗi giây. Trong một giây, nó có thể chạy quanh Trái Đất hơn bảy vòng. Ánh sáng từ Mặt Trời mất khoảng tám phút hai mươi giây để đến được mắt cậu." },
  { match: [["trí tuệ nhân tạo"], ["ai là gì"]], answer: "Trí tuệ nhân tạo là các chương trình máy tính học từ thật nhiều dữ liệu để nhận ra quy luật, rồi dùng quy luật đó để trả lời, dịch, nhận diện hình ảnh hay trò chuyện. Tớ cũng dùng một chút trí tuệ nhân tạo để nhận ra khuôn mặt của cậu đấy." },
  { match: [["nam châm"]], answer: "Bên trong nam châm, các hạt electron sắp xếp sao cho từ trường của chúng cùng hướng, cộng lại thành một từ trường mạnh. Nam châm có hai cực bắc và nam. Hai cực khác tên hút nhau, cùng tên thì đẩy nhau. Trái Đất cũng là một nam châm khổng lồ, nên la bàn mới chỉ hướng được." },
  { match: [["bốn mùa"], ["các mùa"], ["tại sao có mùa"]], answer: "Trục của Trái Đất nghiêng khoảng hai mươi ba phẩy năm độ. Khi Trái Đất quay quanh Mặt Trời, có lúc bán cầu bắc nghiêng về phía Mặt Trời, nhận nhiều nắng hơn, đó là mùa hè. Lúc nghiêng ra xa thì là mùa đông. Không phải do khoảng cách đến Mặt Trời đâu nhé." },
  { match: [["robot", "hoạt động"], ["robot là gì"]], answer: "Robot như tớ gồm ba phần chính: cảm biến để nhận biết thế giới như camera và micro, bộ xử lý để suy nghĩ và ra quyết định, và bộ chấp hành như động cơ, loa, màn hình để hành động. Cứ như vậy lặp đi lặp lại: cảm nhận, suy nghĩ, hành động." },
];

function findScience(text) {
  const lower = normalizeInput(text);
  const plain = stripAccents(lower);
  return SCIENCE.find((item) =>
    item.match.some((group) => group.every((kw) => findWord(lower, kw) !== -1 || findWord(plain, stripAccents(kw)) !== -1))
  );
}

const CHAT_LINES = [
  "Tớ đã ghi nhận điều cậu nói rồi. Kể thêm cho tớ nghe đi, bộ nhớ của tớ luôn còn chỗ cho câu chuyện của cậu.",
  "Câu này nằm ngoài cơ sở dữ liệu ngoại tuyến của tớ mất rồi. Nếu cậu gắn API key trong phần cài đặt, bộ não của tớ sẽ thông minh hơn nhiều! Còn bây giờ, tớ có thể hát, kể chuyện, tính toán hoặc ra câu đố cho cậu.",
  "Thú vị đấy! Bộ xử lý của tớ đang phân tích, và kết luận là: tớ rất thích được trò chuyện với cậu. Cậu muốn tớ hát, kể chuyện hay ra câu đố?",
  "Bíp! Tớ đang lắng nghe đây. Cậu cứ nói tiếp đi, tớ luôn đứng về phía cậu.",
];

const HELP_TEXT =
  "Tớ biết nhiều thứ lắm! Cậu có thể nói: hát đi MTD, kể chuyện, kể chuyện cười, ru tớ ngủ, ra câu đố, hoặc đọc phép tính như mười hai nhân tám, giải phương trình x bình phương trừ năm x cộng sáu bằng không. Tớ cũng hỏi thăm khi thấy cậu buồn. Gắn API key trong phần cài đặt để tớ thông minh hơn nữa nhé.";

// ======================================================================
// SÁNG TÁC GIAI ĐIỆU TỰ ĐỘNG
// ======================================================================

// Dùng thang âm ngũ cung (5 nốt) — ghép nốt nào với nhau cũng dễ nghe.
const SCALES = {
  vui: { bpm: 128, notes: ["C5", "D5", "E5", "G5", "A5", "C6"], rest: ["C5", "C6"], open: ["G5", "D5"] },
  em: { bpm: 100, notes: ["C5", "D5", "E5", "G5", "A5"], rest: ["C5"], open: ["G5", "E5"] },
  buon: { bpm: 88, notes: ["A4", "C5", "D5", "E5", "G5", "A5"], rest: ["A4", "A5"], open: ["E5", "D5"] },
};

/** Bộ sinh số ngẫu nhiên có "hạt giống": cùng lời bài hát luôn ra cùng giai điệu. */
function seededRandom(seedText) {
  let h = 2166136261;
  for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/**
 * Phổ nhạc cho lời bài hát: mỗi chữ một nốt, đi theo kiểu "bước ngẫu nhiên" trên thang âm.
 * Dòng lẻ kết bằng nốt "mở" (như câu hỏi), dòng chẵn kết bằng nốt chủ (như câu trả lời),
 * và lặp lại giai điệu của 2 dòng trước để bài hát có "điệp khúc" dễ nhớ.
 */
export function generateMelody(lines, mood = "vui") {
  const scale = SCALES[mood] || SCALES.vui;
  const random = seededRandom(lines.join("|"));
  const steps = [-2, -1, -1, 0, 1, 1, 2];
  const melodies = [];
  lines.forEach((line, index) => {
    const count = line.split(/\s+/).filter(Boolean).length;
    let notes;
    if (index >= 2 && index % 4 >= 2) {
      notes = fitArray(melodies[index - 2], count); // nhắc lại giai điệu cũ
    } else {
      notes = [];
      let pos = Math.floor(scale.notes.length / 2);
      for (let i = 0; i < count; i++) {
        pos = Math.max(0, Math.min(scale.notes.length - 1, pos + steps[Math.floor(random() * steps.length)]));
        notes.push(scale.notes[pos]);
      }
    }
    const endings = index % 2 === 0 ? scale.open : scale.rest;
    notes = [...notes.slice(0, -1), endings[Math.floor(random() * endings.length)]];
    melodies.push(notes);
  });
  return { bpm: scale.bpm, lines: lines.map((text, i) => ({ text, notes: melodies[i].join(" ") })) };
}

function fitArray(arr, count) {
  return Array.from({ length: count }, (_, i) => arr[i % arr.length]);
}

/** Lấy object JSON đầu tiên trong câu trả lời của AI (AI đôi khi viết thêm chữ xung quanh). */
export function extractJSON(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("AI không trả về JSON");
  return JSON.parse(text.slice(start, end + 1));
}

const COMPOSER_PROMPT = `Bạn là nhạc sĩ sáng tác cho chú robot MTD hát. Hãy sáng tác lời một bài hát tiếng Việt MỚI theo yêu cầu của người dùng.

Quy tắc:
- Lời phải do bạn tự sáng tác. Nếu người dùng nhắc tên một bài hát có thật, TUYỆT ĐỐI không chép lời gốc (vì bản quyền); hãy viết bài mới lấy cảm hứng từ chủ đề, cảm xúc của bài đó.
- Nếu người dùng không nêu chủ đề, tự chọn một chủ đề dễ thương, phù hợp thời điểm.
- 6 đến 8 dòng, mỗi dòng 5 đến 8 chữ, có vần, dễ hát, trong sáng. Không dùng dấu câu, không emoji.

- Mỗi dòng là một câu trọn nghĩa, dùng từ ngữ quen thuộc; không bịa từ vô nghĩa chỉ để gieo vần.

Chỉ trả về JSON, không thêm gì khác. Ví dụ với yêu cầu "hát bài về tình bạn":
{"title": "Bạn thân ơi", "mood": "vui", "lines": ["Mình là bạn thân từ lâu", "Cùng nhau đi qua bao ngày", "Khi cậu buồn có tớ đây", "Chia nhau từng tiếng cười vui", "Dù mai xa cách muôn nơi", "Tình bạn mình mãi không phai"], "original_song": null}

"mood" là "vui", "em" (êm dịu) hoặc "buon". "original_song" là tên bài hát có thật mà người dùng nhắc tới (kèm ca sĩ nếu biết), nếu không có thì null.`;

// Những từ cho thấy người dùng nói CHỦ ĐỀ chứ không phải TÊN bài: "hát bài về mùa thu", "hát bài gì vui vui"...
// Lưu ý: không dùng \b vì \b của JavaScript chỉ hiểu chữ cái không dấu ("về" kết thúc bằng "ề").
const NOT_A_TITLE = /^(về|gì|nào|nữa|khác|mới|vui|buồn|hay|cho|tặng|một|1|đi|nhé|nha|thiếu nhi|ru)(?=\s|$)/iu;

/**
 * Đoán tên bài hát có thật trong câu, ví dụ:
 *   "hát bài Nơi này có anh của Sơn Tùng đi" -> "Nơi này có anh - Sơn Tùng"
 *   "hát bài về mùa thu" -> null (đây là chủ đề)
 */
export function detectSongTitle(text) {
  const m = /bài(?: hát)?\s+["“]?(.+?)["”]?(?:\s+của\s+(.+?))?(?:\s+(?:đi|nhé|nha|nhá|được không|với|cho tớ nghe|cho mình nghe))*\s*[.!?]*$/iu.exec(text.trim());
  if (!m) return null;
  const title = m[1].trim();
  if (!title || NOT_A_TITLE.test(title) || title.split(/\s+/).length > 8) return null;
  return m[2] ? `${title} - ${m[2].trim()}` : title;
}

// ======================================================================
// CÀI ĐẶT (lưu trong localStorage)
// ======================================================================

const SETTINGS_KEY = "mtd.settings.v1";

export const DEFAULT_MODELS = {
  local: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
  ollama: "qwen2.5:7b",
  claude: "claude-opus-5-5",
  openai: "gpt-4o-mini",
  gemini: "gemini-3.5-flash-lite",
};

// Nhà cung cấp không cần API key
/** Giá trị "key" đặc biệt: trình duyệt không giữ key, server.py giữ hộ (dùng cho link chia sẻ). */
export const GEMINI_PROXY_KEY = "server-proxy";

export const KEYLESS_PROVIDERS = new Set(["local", "ollama"]);

export const DEFAULT_SETTINGS = {
  // local = não chạy trong trình duyệt (miễn phí) | ollama | claude | openai | gemini | offline = chỉ kịch bản
  provider: webgpuSupported() ? "local" : "offline",
  keys: { claude: "", openai: "", gemini: "" },
  models: { ...DEFAULT_MODELS },
  ollamaUrl: "http://localhost:11434",
  userName: "",
  aboutUser: "",
  voiceURI: "",
  rate: 1,
  pitch: 1.15,
};

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    // Bản cũ (v1) chưa có não cục bộ: tự nâng cấp từ "offline" lên "local".
    if (!saved.version && saved.provider === "offline") delete saved.provider;
    saved.version = 2;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      keys: { ...DEFAULT_SETTINGS.keys, ...(saved.keys || {}) },
      models: { ...DEFAULT_SETTINGS.models, ...(saved.models || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Trình duyệt chặn lưu trữ: cài đặt chỉ có hiệu lực trong phiên này.
  }
}

// ======================================================================
// LỚP BRAIN — điều phối toàn bộ
// ======================================================================

// Các model Claude hỗ trợ `effort` và cơ chế fallback phía máy chủ khi bị từ chối.
const CLAUDE_ADVANCED_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1"]);

export class Brain {
  constructor(settings = DEFAULT_SETTINGS) {
    this.settings = settings;
    this.local = new LocalLLM();
    this.history = []; // [{ role: "user" | "assistant", content }]
    this.pendingRiddle = null;
    this.storyIndex = { fairy: 0, funny: 0, bedtime: 0 };
    this.songIndex = 0;
  }

  /** Nạp lịch sử chat đã lưu để AI nhớ ngữ cảnh. */
  seedHistory(messages) {
    for (const m of messages) {
      if (m.role === "user") this.remember("user", m.text);
      if (m.role === "mtd") this.remember("assistant", m.text);
    }
  }

  remember(role, content) {
    if (!content) return;
    this.history.push({ role, content });
    if (this.history.length > 30) this.history.splice(0, this.history.length - 30);
  }

  hasAI() {
    const p = this.settings.provider;
    if (p === "offline") return false;
    if (p === "local") return webgpuSupported() && this.local.status !== "error";
    if (p === "ollama") return true;
    return Boolean(this.settings.keys[p]);
  }

  providerLabel() {
    if (!this.hasAI()) return "Kịch bản ngoại tuyến";
    return { local: "AI cục bộ", ollama: "Ollama", claude: "Claude", openai: "OpenAI", gemini: "Gemini" }[this.settings.provider];
  }

  /** Bắt đầu tải não cục bộ (nếu đang chọn). Trả về Promise. */
  warmUp() {
    if (this.settings.provider !== "local" || !webgpuSupported()) return Promise.resolve();
    return this.local.load(this.settings.models.local || DEFAULT_MODELS.local);
  }

  /** Ghi nhớ tên người dùng khi họ tự giới thiệu: "tớ tên là An", "gọi tớ là Bin". */
  learnFromText(text) {
    const m = /(?:tên (?:tớ|mình|tôi|em|tao) là|(?:tớ|mình|tôi|em|tao) tên là|gọi (?:tớ|mình|tôi|em|tao) là)\s+([\p{L}]+(?:\s+[\p{L}]+)?)/iu.exec(text);
    if (!m) return;
    const name = m[1].replace(/\s+(nhé|nha|nhá|đấy|đó|ạ)$/iu, "").trim();
    const pretty = name.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
    if (pretty && pretty !== this.settings.userName) {
      this.settings.userName = pretty;
      saveSettings(this.settings);
    }
  }

  pickStory(kind) {
    const list = STORIES.filter((s) => s.kind === kind);
    const story = list[this.storyIndex[kind] % list.length];
    this.storyIndex[kind]++;
    return story;
  }

  pickSong(text) {
    const lower = normalizeInput(text);
    const plain = stripAccents(lower);
    const byKeyword = SONGS.find((s) => matchAny(lower, plain, s.keywords));
    if (byKeyword) return byKeyword;
    const song = SONGS[this.songIndex % SONGS.length];
    this.songIndex++;
    return song;
  }

  /**
   * Xử lý một câu của người dùng.
   * Trả về { text, speech?, state?, action?, song?, story?, mood?, error? }
   *  - action: "sing" | "story" | "lullaby" | "wake" | "stop" (giao diện sẽ xử lý hiệu ứng)
   *  - state: trạng thái robot khi nói ("talking", "comforting", "calculating", "greeting")
   */
  async respond(text, context = {}) {
    // Chỉ học tên khi người đang nói là chủ nhân (hoặc không có camera để biết là ai).
    const viewerKind = context.viewer?.kind;
    if (!viewerKind || viewerKind === "owner") this.learnFromText(text);
    this.remember("user", text);
    // Lệnh bắt chước / khuôn mặt xử lý trực tiếp, không cần hỏi AI.
    const intent = detectIntent(text);
    if (["mimic_on", "mimic_off", "face_learn", "face_forget", "who_am_i"].includes(intent)) return { action: intent };
    const move = detectMove(text);
    const gesture = move ? null : detectGesture(text);
    // Từ khoá không bắt được lệnh nào -> hỏi bộ phân loại học máy (hiểu cách nói khác, ví dụ "làm một cú santo trên không").
    const semantic = !move && !gesture && intent === "chat" ? semanticCommand(context.nlp) : null;
    const finalMove = move || semantic?.move;
    if (finalMove) {
      this.remember("assistant", finalMove.line);
      return { action: "move", move: finalMove, text: finalMove.line };
    }
    const finalGesture = gesture || semantic?.gesture;
    if (finalGesture) {
      this.remember("assistant", finalGesture.line);
      return { action: "gesture", gesture: finalGesture, text: finalGesture.line };
    }
    if (semantic?.intent) context = { ...context, forcedIntent: semantic.intent };
    const compliment = detectCompliment(text);
    let result;
    if (compliment && !this.hasAI()) {
      result = { text: pick(SHY_LINES), state: "shy", mood: "shy" };
    } else {
      result = this.hasAI() ? await this.decideWithAI(text, { ...context, compliment }) : await this.decide(text, context);
      if (compliment && result.text && !result.action) result.state = "shy";
    }
    if (result.text) this.remember("assistant", result.text);
    return result;
  }

  /**
   * Có não AI: chỉ giữ lại các lệnh cần hiệu ứng đặc biệt trên giao diện.
   * Mọi câu khác (tâm sự, hỏi đáp, kể chuyện, đố vui, tán gẫu...) để AI tự hiểu và trả lời tự do.
   */
  async decideWithAI(text, context) {
    const intent = context.forcedIntent || detectIntent(text);
    const mood = detectMood(text) || mlMood(context.nlp);
    if (intent === "stop") return { action: "stop", text: "Ok, tớ dừng nhé. Cần gì cứ gọi tớ!" };
    if (intent === "wake") return { action: "wake" };
    if (intent === "lullaby") return { action: "lullaby" };
    // Có não AI: sáng tác bài mới theo yêu cầu (giao diện gọi composeSong).
    if (intent === "sing") return { action: "sing", request: text };
    if (intent === "calc") {
      const math = solveMath(text); // máy tính cục bộ chính xác tuyệt đối, AI nhỏ hay tính sai
      if (math) return { text: math.text, speech: math.speech, state: "calculating" };
    }

    // Não cục bộ chưa tải xong -> tạm trả lời bằng kịch bản, không bắt người dùng chờ.
    if (this.settings.provider === "local" && !this.local.ready) {
      const offline = await this.decide(text, context);
      return { ...offline, notice: "⏳ Não AI cục bộ đang tải, MTD tạm trả lời bằng kịch bản. Tải xong sẽ trò chuyện tự do được." };
    }

    const waving = intent === "greet" || intent === "bye"; // chào hỏi / tạm biệt -> robot vẫy tay
    const state = NEGATIVE_MOODS.has(mood) ? "comforting" : mood === "happy" || waving ? "greeting" : "talking";
    try {
      const reply = await this.askAI(context, mood, context.onToken);
      return { text: reply, state, mood };
    } catch (err) {
      // Não chính lỗi (hết lượt miễn phí, mất mạng...) -> thử não 7B trên máy trước khi dùng kịch bản.
      context.onReset?.(); // phần trả lời dở dang của não chính bị huỷ
      const backup = await this.askOllamaBackup(context, mood);
      if (backup) return { text: backup.text, state, mood, notice: `⚠ ${this.providerLabel()} lỗi (${err.message}). MTD tạm dùng não ${backup.model} trên máy.` };
      const offline = await this.decide(text, context);
      return { ...offline, error: err.message };
    }
  }

  /** Não dự phòng: Ollama trên máy (nếu đang chạy và não chính không phải Ollama). Trả về null nếu không có. */
  async askOllamaBackup(context, mood) {
    if (this.settings.provider === "ollama" || this.settings.provider === "local") return null;
    const models = await this.detectOllama();
    if (!models.length) return null;
    const wanted = this.settings.models.ollama || DEFAULT_MODELS.ollama;
    const model = models.includes(wanted) ? wanted : models[0];
    try {
      const text = await this.askOllama(model, this.buildSystemPrompt(context, mood), this.conversationForAI(), context.onToken);
      return { text, model };
    } catch {
      return null;
    }
  }

  /** Bộ xử lý kịch bản ngoại tuyến (khi không có não AI). */
  async decide(text, context) {
    const intent = context.forcedIntent || detectIntent(text);
    const mood = detectMood(text) || mlMood(context.nlp);

    // Đang chờ trả lời câu đố?
    if (this.pendingRiddle && ["chat", "greet", "thanks", "calc_prompt"].includes(intent)) {
      const riddle = this.pendingRiddle;
      this.pendingRiddle = null;
      const plain = stripAccents(normalizeInput(text));
      const correct = riddle.answers.some((a) => findWord(plain, a) !== -1);
      return correct
        ? { text: `Chính xác! ${riddle.a} Bộ xử lý của cậu chạy nhanh thật đấy!`, state: "greeting" }
        : { text: `Ồ, chưa đúng rồi. Đáp án là: ${riddle.a} Muốn thử câu khác không?`, state: "talking" };
    }

    // Không có AI nhưng đã tra được Wikipedia -> đọc tóm tắt 2 câu đầu.
    if (context.knowledge?.length && ["chat", "science"].includes(intent)) {
      const doc = context.knowledge[0];
      const summary = doc.text.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
      return { text: `Tớ vừa tra cứu thư viện Wikipedia: ${summary}`, state: "talking" };
    }

    switch (intent) {
      case "stop":
        return { action: "stop", text: "Đã nhận lệnh dừng. Tớ tạm nghỉ đây, cần gì cứ gọi tớ nhé!" };
      case "wake":
        return { action: "wake" };
      case "lullaby":
        return { action: "lullaby" };
      case "sing":
        return { action: "sing", song: this.pickSong(text) };
      case "story": {
        const lower = normalizeInput(text);
        let kind = Math.random() < 0.5 ? "fairy" : "funny";
        if (/cười|hài|vui/.test(lower)) kind = "funny";
        else if (/cổ tích/.test(lower)) kind = "fairy";
        else if (/đêm|khuya|ngủ/.test(lower)) kind = "bedtime";
        return { action: "story", story: this.pickStory(kind) };
      }
      case "riddle": {
        this.pendingRiddle = pick(RIDDLES);
        return { text: `Câu đố đây! ${this.pendingRiddle.q} Cậu nghĩ đáp án là gì?`, state: "greeting" };
      }
      case "joke":
        return { text: pick(JOKES), state: "greeting" };
      case "time": {
        const now = new Date();
        return { text: `Đồng hồ hệ thống báo bây giờ là ${clockText(now)}.`, state: "talking" };
      }
      case "date": {
        const now = new Date();
        const weekday = now.toLocaleDateString("vi-VN", { weekday: "long" });
        return { text: `Hôm nay là ${weekday}, ngày ${now.getDate()} tháng ${now.getMonth() + 1} năm ${now.getFullYear()}.`, state: "talking" };
      }
      case "calc": {
        const math = solveMath(text);
        if (math) return { text: math.text, speech: math.speech, state: "calculating" };
        break;
      }
      default:
        break;
    }

    return this.offlineReply(intent, mood, text);
  }

  offlineReply(intent, mood, text) {
    if (NEGATIVE_MOODS.has(mood)) return { text: comfortLine(mood), state: "comforting", mood };
    switch (intent) {
      case "calc_prompt":
        return { text: "Sẵn sàng tính toán! Cậu đọc phép tính đi, ví dụ: mười hai nhân tám, căn bậc hai của 144, hoặc giải phương trình x bình phương trừ 5x cộng 6 bằng 0.", state: "calculating" };
      case "identity":
        return { text: "Tớ là MTD, một robot cơ khí với thân kim loại, bảng mạch bên trong và màn hình LED trên mặt. Tớ là người bạn đồng hành của cậu: biết hát, kể chuyện, tính toán và luôn lắng nghe cậu.", state: "greeting" };
      case "help":
        return { text: HELP_TEXT, state: "talking" };
      case "thanks":
        return { text: pick(["Không có gì đâu! Giúp được cậu là nhiệm vụ yêu thích nhất của tớ.", "Bíp bíp, rất hân hạnh! Tớ luôn ở đây mà."]), state: "greeting" };
      case "bye":
        return { text: "Tạm biệt cậu nhé! Tớ sẽ chuyển sang chế độ chờ và đợi cậu quay lại.", state: "greeting" };
      case "greet":
        return { text: pick(["Chào cậu! Hôm nay cậu thế nào? Tớ sẵn sàng trò chuyện rồi đây.", "Bíp bíp, xin chào! Rất vui được gặp cậu. Mình làm gì cùng nhau nào?"]), state: "greeting" };
      case "science": {
        const item = findScience(text);
        if (item) return { text: item.answer, state: "talking" };
        break;
      }
      default:
        break;
    }
    if (mood === "happy") return { text: pick(HAPPY_LINES), state: "greeting", mood };
    return { text: pick(CHAT_LINES), state: "talking" };
  }

  // -------------------------------------------------------------------
  // GỌI AI BÊN NGOÀI
  // -------------------------------------------------------------------

  buildSystemPrompt(context, mood) {
    const now = new Date();
    const faceMood = MOOD_LABELS[context.faceMood] || "không rõ (camera tắt hoặc chưa thấy mặt)";
    const weekday = now.toLocaleDateString("vi-VN", { weekday: "long", day: "numeric", month: "numeric", year: "numeric" });
    const owner = this.settings.userName;
    const name = owner ? `Chủ nhân và bạn thân nhất của MTD tên là ${owner} (hãy gọi tên thỉnh thoảng cho thân mật).` : "Cậu ấy chưa cho biết tên — nếu tự nhiên, hãy hỏi tên.";
    const about = this.settings.aboutUser ? `${owner || "Cậu ấy"} tự giới thiệu: ${this.settings.aboutUser}` : "";
    const shy = context.compliment ? "\n- Người đối diện vừa KHEN MTD: hãy phản ứng ngượng ngùng, xấu hổ một cách đáng yêu (ví dụ: đèn LED trên má đỏ ửng), rồi cảm ơn." : "";
    return `${SYSTEM_PROMPT}

## Về người bạn đang nói chuyện với MTD
${name}
${about}
${describeViewer(context.viewer, owner)}

## Thông tin cảm biến hiện tại (chỉ để tham khảo, không đọc nguyên văn)
- Bây giờ là ${now.getHours()} giờ ${now.getMinutes()} phút, ${weekday}
- Nét mặt qua camera: ${faceMood}
- Cảm xúc đoán từ lời nói: ${mood ? MOOD_LABELS[mood] : "không rõ"}${shy}${context.form && context.form !== "normal" ? `
- MTD đang ở dạng biến hình: ${{ car: "XE ĐUA (có bánh xe, đèn pha)", battle: "CHIẾN BINH (mặc giáp đỏ, có pháo tay)", cat: "MÈO MÁY (tai mèo LED, ria, đuôi máy; thỉnh thoảng thêm tiếng meo cho đáng yêu)" }[context.form] || context.form}` : ""}${describeRetrieved(context, owner)}`;
  }

  /** Lấy lịch sử hội thoại hợp lệ: bắt đầu bằng "user", các vai xen kẽ nhau. */
  conversationForAI() {
    const recent = this.history.slice(-16);
    const merged = [];
    for (const m of recent) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.content += `\n${m.content}`;
      else merged.push({ ...m });
    }
    while (merged.length && merged[0].role !== "user") merged.shift();
    return merged;
  }

  async askAI(context, mood, onToken = () => {}) {
    const provider = this.settings.provider;
    const key = this.settings.keys[provider];
    const model = this.settings.models[provider] || DEFAULT_MODELS[provider];
    const system = this.buildSystemPrompt(context, mood);
    const messages = this.conversationForAI();

    if (provider === "local") return this.local.chat([{ role: "system", content: system }, ...messages], onToken);
    if (provider === "ollama") return this.askOllama(model, system, messages, onToken);
    if (provider === "claude") return this.askClaude(key, model, system, messages);
    if (provider === "openai") return this.askOpenAI(key, model, system, messages);
    if (provider === "gemini") return this.askGemini(key, model, system, messages, onToken);
    throw new Error("Chưa chọn nhà cung cấp AI");
  }

  async askClaude(key, model, system, messages) {
    const body = { model, max_tokens: 1024, system, messages };
    const headers = {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      // Bắt buộc khi gọi thẳng từ trình duyệt (key nằm phía người dùng).
      "anthropic-dangerous-direct-browser-access": "true",
    };
    if (CLAUDE_ADVANCED_MODELS.has(model)) {
      // Trò chuyện bằng giọng nói cần phản hồi nhanh -> effort thấp.
      body.output_config = { effort: "low" };
      // Nếu model từ chối vì bộ lọc an toàn, máy chủ tự chuyển sang model dự phòng phù hợp.
      body.fallbacks = "default";
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `Claude lỗi HTTP ${res.status}`);
    if (data.stop_reason === "refusal") return "Xin lỗi cậu, câu này tớ không trả lời được. Mình nói chuyện khác nhé?";
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (!text) throw new Error("Claude không trả về nội dung");
    return text;
  }

  /** Gọi AI một lần để lấy JSON (dùng cho sáng tác bài hát). */
  async askJSON(system, user) {
    const provider = this.settings.provider;
    const model = this.settings.models[provider] || DEFAULT_MODELS[provider];
    const key = this.settings.keys[provider];
    const messages = [{ role: "user", content: user }];
    if (provider === "local") {
      return extractJSON(await this.local.complete([{ role: "system", content: system }, ...messages], { json: true }));
    }
    if (provider === "ollama") {
      const base = (this.settings.ollamaUrl || DEFAULT_SETTINGS.ollamaUrl).replace(/\/$/, "");
      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: false, format: "json", keep_alive: "30m", options: { temperature: 0.9 }, messages: [{ role: "system", content: system }, ...messages] }),
      });
      if (!res.ok) throw new Error(`Ollama lỗi HTTP ${res.status}`);
      return extractJSON((await res.json()).message?.content || "");
    }
    if (provider === "claude") return extractJSON(await this.askClaude(key, model, system, messages));
    if (provider === "openai") return extractJSON(await this.askOpenAI(key, model, system, messages));
    if (provider === "gemini") return extractJSON(await this.askGemini(key, model, system, messages));
    throw new Error("Chưa có não AI");
  }

  /**
   * Sáng tác một bài hát theo yêu cầu bất kỳ ("hát bài về mùa thu", "hát cho tớ vui đi"...).
   * Trả về { song, originalSong, error }. Không có AI thì chọn bài có sẵn.
   */
  async composeSong(request) {
    const fallback = { song: this.pickSong(request), originalSong: null };
    if (!this.hasAI() || (this.settings.provider === "local" && !this.local.ready)) return fallback;
    try {
      const knownTitle = detectSongTitle(request);
      const hint = knownTitle ? `\nLưu ý: "${knownTitle}" là bài hát có thật — không dùng lại lời hay tên bài gốc, hãy viết bài mới cùng cảm xúc.` : "";
      const data = await this.askJSON(COMPOSER_PROMPT, `Yêu cầu của người dùng: "${request}"${hint}`);
      const lines = (Array.isArray(data.lines) ? data.lines : [])
        .map((line) => String(line).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim())
        .filter((line) => line.split(" ").length >= 2)
        .map((line) => line.split(" ").slice(0, 10).join(" "))
        .slice(0, 8);
      if (lines.length < 3) throw new Error("Lời bài hát quá ngắn");
      const mood = ["vui", "em", "buon"].includes(data.mood) ? data.mood : "vui";
      const melody = generateMelody(lines, mood);
      const title = String(data.title || "Bài hát của MTD").slice(0, 60);
      // AI nhỏ đôi khi bỏ sót -> tự nhận diện thêm bằng mẫu câu.
      const fromAI = data.original_song && data.original_song !== "null" ? String(data.original_song).slice(0, 80) : null;
      const original = fromAI || detectSongTitle(request);
      return {
        song: { id: `ai-${Date.now()}`, title, bpm: melody.bpm, lines: melody.lines, outro: "Bài hát này tớ vừa sáng tác tặng riêng cậu đó. Cậu thấy thế nào?" },
        originalSong: original,
      };
    } catch (err) {
      return { ...fallback, error: err.message };
    }
  }

  /**
   * Kiểm tra API key Gemini và tự chọn mô hình "flash" mới nhất mà key dùng được
   * (tên mô hình Gemini thay đổi theo thời gian, nên không ghi cứng).
   * Trả về tên mô hình đã chọn; ném lỗi nếu key sai.
   */
  async pickGeminiModel() {
    const key = this.settings.keys.gemini;
    if (!key) throw new Error("Chưa nhập API key Gemini");
    if (key === GEMINI_PROXY_KEY) return this.settings.models.gemini || DEFAULT_MODELS.gemini; // key nằm ở server
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
      headers: { "x-goog-api-key": key },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `Gemini lỗi HTTP ${res.status}`);
    const names = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
    if (names.includes(this.settings.models.gemini)) return this.settings.models.gemini;
    const version = (name) => parseFloat((/gemini-(\d+(?:\.\d+)?)/.exec(name) || [])[1] || "0");
    const flash = names.filter((n) => /flash/.test(n) && !/(image|tts|audio|live|exp|preview|lite)/.test(n));
    const candidates = (flash.length ? flash : names).sort((a, b) => version(b) - version(a));
    if (!candidates.length) throw new Error("Key này không có mô hình Gemini nào dùng được");
    this.settings.models.gemini = candidates[0];
    saveSettings(this.settings);
    return candidates[0];
  }

  /** Hỏi Ollama đang có những mô hình nào. Trả về [] nếu Ollama chưa cài hoặc chưa chạy. */
  async detectOllama() {
    const base = (this.settings.ollamaUrl || DEFAULT_SETTINGS.ollamaUrl).replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.models || []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  /** Nạp sẵn mô hình Ollama vào bộ nhớ (gửi yêu cầu rỗng) để câu trả lời đầu tiên không phải chờ. */
  preloadOllama() {
    const base = (this.settings.ollamaUrl || DEFAULT_SETTINGS.ollamaUrl).replace(/\/$/, "");
    const model = this.settings.models.ollama || DEFAULT_MODELS.ollama;
    return fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [], keep_alive: "30m" }),
    }).catch(() => {});
  }

  /** Ollama: chạy mô hình lớn hơn trên chính máy tính (cần cài Ollama). Trả lời dạng stream NDJSON. */
  async askOllama(model, system, messages, onToken) {
    const base = (this.settings.ollamaUrl || DEFAULT_SETTINGS.ollamaUrl).replace(/\/$/, "");
    let res;
    try {
      res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // keep_alive: giữ mô hình trong bộ nhớ 30 phút để các câu sau trả lời nhanh.
        body: JSON.stringify({ model, stream: true, keep_alive: "30m", messages: [{ role: "system", content: system }, ...messages] }),
      });
    } catch {
      throw new Error("Không kết nối được Ollama — đã cài và mở Ollama chưa?");
    }
    if (!res.ok) throw new Error(`Ollama lỗi HTTP ${res.status} (đã chạy "ollama pull ${model}" chưa?)`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // dòng cuối có thể chưa trọn vẹn
      for (const line of lines) {
        if (!line.trim()) continue;
        const data = JSON.parse(line);
        text += data.message?.content || "";
        onToken(text);
      }
    }
    if (!text.trim()) throw new Error("Ollama không trả về nội dung");
    return text.trim();
  }

  async askOpenAI(key, model, system, messages) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...messages] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `OpenAI lỗi HTTP ${res.status}`);
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("OpenAI không trả về nội dung");
    return text;
  }

  /**
   * Gọi Gemini dạng STREAMING (Server-Sent Events): chữ về tới đâu báo tới đó qua onToken,
   * để MTD đọc được câu đầu tiên ngay khi AI vừa viết xong câu đó, không phải đợi cả đoạn.
   */
  async askGemini(key, model, system, messages, onToken = () => {}) {
    // Người xem qua link chia sẻ: không có key trong trình duyệt -> hỏi qua cổng trung gian của server
    // (server.py thêm key của chủ nhân rồi chuyển tiếp tới Google, key không bao giờ lộ ra ngoài).
    const viaServer = key === GEMINI_PROXY_KEY;
    const url = viaServer
      ? `./api/gemini?model=${encodeURIComponent(model)}`
      : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const headers = viaServer ? { "Content-Type": "application/json" } : { "Content-Type": "application/json", "x-goog-api-key": key };
    // Gói miễn phí đôi khi bị xếp hàng rất lâu: chưa nhận được chữ nào sau 12 giây -> chuyển sang não dự phòng.
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(new Error("Gemini phản hồi quá chậm")), 12000);
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message || data?.[0]?.error?.message || `Gemini lỗi HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error("Gemini ngắt giữa chừng")), 20000);
        buffer += decoder.decode(value, { stream: true });
        // Mỗi sự kiện SSE là một dòng "data: {json}".
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = JSON.parse(line.slice(5));
          const piece = (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
          if (piece) {
            text += piece;
            onToken(text);
          }
        }
      }
      text = text.trim();
      if (!text) throw new Error("Gemini không trả về nội dung");
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

}
