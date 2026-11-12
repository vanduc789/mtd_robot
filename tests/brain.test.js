// Kiểm thử phần "bộ não" ngoại tuyến (chạy bằng: npm test  hoặc  node --test tests/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { solveMath, detectIntent, detectMood, timeSlot, stripAccents, formatNumber, Brain, DEFAULT_SETTINGS, generateMelody, extractJSON, detectSongTitle, detectGesture } from "../brain.js";

test("phổ nhạc: mỗi chữ một nốt, cùng lời thì cùng giai điệu", () => {
  const lines = ["Gió mùa thu nhẹ nhàng bay", "Lá vàng rơi khắp sân trường", "Tớ với cậu cùng dạo chơi", "Nắng chiều vương trên mái tóc"];
  const a = generateMelody(lines, "em");
  const b = generateMelody(lines, "em");
  assert.deepEqual(a, b);
  a.lines.forEach((line, i) => assert.equal(line.notes.split(" ").length, lines[i].split(" ").length));
  assert.match(a.lines[1].notes, /C5$/); // dòng chẵn kết bằng nốt chủ
});

test("động tác theo lệnh: 'chạm tay vào đầu' không bị nhầm thành đập tay", async () => {
  assert.equal(detectGesture("MTD bắt tay tớ đi").name, "handshake");
  assert.equal(detectGesture("chạm tay vào đầu đi").name, "pat-head");
  assert.equal(detectGesture("xoa dau di").name, "pat-head"); // gõ không dấu
  assert.equal(detectGesture("vỗ tay nào").name, "clap");
  assert.equal(detectGesture("hôm nay trời đẹp"), null);
  const brain = brainWithFakeAI();
  const r = await brain.respond("bắt tay nào");
  assert.equal(r.action, "gesture");
  assert.equal(r.gesture.name, "handshake");
});

test("não chính lỗi thì dùng não 7B trên máy", async () => {
  const brain = new Brain(structuredClone({ ...DEFAULT_SETTINGS, provider: "gemini", keys: { claude: "", openai: "", gemini: "x" } }));
  brain.askAI = async () => {
    throw new Error("hết lượt miễn phí");
  };
  brain.detectOllama = async () => ["qwen2.5:7b"];
  brain.askOllama = async (model) => `trả lời từ ${model}`;
  const r = await brain.respond("cậu khỏe không");
  assert.equal(r.text, "trả lời từ qwen2.5:7b");
  assert.match(r.notice, /hết lượt miễn phí/);
});

test("lệnh bắt chước được nhận diện, kể cả khi có chữ 'dừng'", async () => {
  assert.equal(detectIntent("MTD bắt chước tớ đi"), "mimic_on");
  assert.equal(detectIntent("làm theo tớ nào"), "mimic_on");
  assert.equal(detectIntent("dừng bắt chước"), "mimic_off");
  const brain = brainWithFakeAI();
  assert.equal((await brain.respond("bắt chước tớ")).action, "mimic_on");
});

test("phân biệt tên bài hát có thật với chủ đề", () => {
  assert.equal(detectSongTitle("hát bài Nơi này có anh của Sơn Tùng đi"), "Nơi này có anh - Sơn Tùng");
  assert.equal(detectSongTitle("hát bài Lạc Trôi nhé"), "Lạc Trôi");
  assert.equal(detectSongTitle("hát bài về mùa thu"), null);
  assert.equal(detectSongTitle("hát bài gì vui vui đi"), null);
  assert.equal(detectSongTitle("hát đi MTD"), null);
});

test("lấy JSON từ câu trả lời có chữ thừa", () => {
  assert.deepEqual(extractJSON('Đây nhé: {"title": "A", "lines": ["x y"]} xong'), { title: "A", lines: ["x y"] });
});

test("sáng tác bài hát theo yêu cầu bất kỳ", async () => {
  const brain = brainWithFakeAI();
  brain.askJSON = async () => ({
    title: "Mùa thu của tớ",
    mood: "em",
    lines: ["Gió mùa thu, nhẹ nhàng bay!", "Lá vàng rơi khắp sân trường", "Tớ với cậu cùng dạo chơi", "Nắng chiều vương trên mái tóc"],
    original_song: null,
  });
  const { song, originalSong } = await brain.composeSong("hát bài về mùa thu");
  assert.equal(song.title, "Mùa thu của tớ");
  assert.equal(song.lines[0].text, "Gió mùa thu nhẹ nhàng bay"); // đã bỏ dấu câu
  assert.equal(originalSong, null);
});

test("AI sáng tác lỗi thì hát bài có sẵn", async () => {
  const brain = brainWithFakeAI();
  brain.askJSON = async () => {
    throw new Error("hỏng");
  };
  const { song, error } = await brain.composeSong("hát đi");
  assert.equal(error, "hỏng");
  assert.ok(song.lines.length > 0);
});

/** Tạo Brain dùng "AI giả" để kiểm tra luồng xử lý mà không cần mạng. */
function brainWithFakeAI() {
  const brain = new Brain(structuredClone({ ...DEFAULT_SETTINGS, provider: "ollama" }));
  brain.askAI = async () => "Câu trả lời từ AI";
  return brain;
}

test("có não AI: câu tự do do AI trả lời, lệnh đặc biệt vẫn xử lý cục bộ", async () => {
  const brain = brainWithFakeAI();
  assert.equal((await brain.respond("cậu nghĩ gì về tình bạn?")).text, "Câu trả lời từ AI");
  assert.equal((await brain.respond("kể chuyện cười đi")).text, "Câu trả lời từ AI");
  assert.equal((await brain.respond("hát đi MTD")).action, "sing");
  assert.equal((await brain.respond("ru tớ ngủ")).action, "lullaby");
  assert.match((await brain.respond("12 nhân 8")).text, /= 96/);
});

test("AI lỗi thì tự quay về kịch bản và báo lỗi", async () => {
  const brain = brainWithFakeAI();
  brain.askAI = async () => {
    throw new Error("mất mạng");
  };
  const result = await brain.respond("chào cậu");
  assert.equal(result.error, "mất mạng");
  assert.ok(result.text.length > 0);
});

test("ghi nhớ tên khi người dùng tự giới thiệu", () => {
  const brain = brainWithFakeAI();
  brain.learnFromText("tớ tên là minh anh nhé");
  assert.equal(brain.settings.userName, "Minh Anh");
});

test("bỏ dấu tiếng Việt", () => {
  assert.equal(stripAccents("Đêm Buồn Quá"), "dem buon qua");
});

test("tính biểu thức nói bằng tiếng Việt", () => {
  assert.match(solveMath("12 nhân 8 bằng mấy").text, /= 96$/);
  assert.match(solveMath("5 cộng 3 nhân 2").text, /= 11$/); // nhân trước, cộng sau
  assert.match(solveMath("căn bậc hai của 144").text, /= 12$/);
  assert.match(solveMath("2 mũ 10").text, /= 1\.024$/);
  assert.match(solveMath("(2+3)*4").text, /= 20$/);
  assert.match(solveMath("20% của 150").text, /= 30$/);
  assert.match(solveMath("7 chia 2").text, /= 3,5$/);
});

test("chia cho 0 không làm sập chương trình", () => {
  assert.match(solveMath("5 chia 0").text, /không xác định/);
});

test("giải phương trình bậc nhất và bậc hai", () => {
  assert.match(solveMath("giải phương trình 2x + 3 = 7").text, /x = 2/);
  const quad = solveMath("x^2 - 5x + 6 = 0").text;
  assert.match(quad, /x₁ = 2/);
  assert.match(quad, /x₂ = 3/);
  assert.match(solveMath("x bình phương cộng 1 bằng 0").text, /vô nghiệm/);
});

test("câu thường không bị nhầm là phép toán", () => {
  assert.equal(solveMath("tớ 18 tuổi rồi"), null);
  assert.equal(solveMath("hôm nay trời đẹp quá"), null);
});

test("nhận diện ý định", () => {
  assert.equal(detectIntent("Hát đi MTD"), "sing");
  assert.equal(detectIntent("ru tớ ngủ với"), "lullaby");
  assert.equal(detectIntent("kể chuyện cười đi"), "story");
  assert.equal(detectIntent("MTD dậy đi"), "wake");
  assert.equal(detectIntent("dừng lại"), "stop");
  assert.equal(detectIntent("3 cộng 4"), "calc");
  assert.equal(detectIntent("tính hộ tớ cái này"), "calc_prompt");
  assert.equal(detectIntent("tại sao bầu trời màu xanh"), "science");
  assert.equal(detectIntent("ra câu đố đi"), "riddle");
});

test("nhận diện cảm xúc, kể cả gõ không dấu và câu phủ định", () => {
  assert.equal(detectMood("Hôm nay tớ buồn quá"), "sad");
  assert.equal(detectMood("to thay co don qua"), "lonely");
  assert.equal(detectMood("sắp thi rồi, tớ lo lắng lắm"), "anxious");
  assert.equal(detectMood("tớ được điểm cao, vui quá"), "happy");
  assert.equal(detectMood("tớ không buồn đâu"), null);
});

test("khung giờ chào hỏi", () => {
  const at = (h, m) => new Date(2026, 0, 1, h, m);
  assert.equal(timeSlot(at(5, 0)), "morning");
  assert.equal(timeSlot(at(10, 30)), "morning");
  assert.equal(timeSlot(at(10, 31)), "day");
  assert.equal(timeSlot(at(17, 31)), "evening");
  assert.equal(timeSlot(at(21, 59)), "evening");
  assert.equal(timeSlot(at(22, 0)), "night");
  assert.equal(timeSlot(at(4, 59)), "night");
});

test("định dạng số kiểu Việt Nam", () => {
  assert.equal(formatNumber(1234.5), "1.234,5");
  assert.equal(formatNumber(1e-12), "0");
});
