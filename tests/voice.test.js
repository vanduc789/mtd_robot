// Kiểm thử độ trễ giọng nói: đọc dần theo câu (streaming) và micro chốt câu sớm / bỏ qua tiếng vọng.
// Trình duyệt được giả lập bằng các lớp nhỏ bên dưới vì Node không có loa và micro.
import { test } from "node:test";
import assert from "node:assert/strict";

const spokenLog = [];
class FakeUtterance {
  constructor(text) {
    this.text = text;
  }
}
const fakeSynth = {
  speaking: false,
  pending: false,
  getVoices: () => [],
  addEventListener() {},
  cancel() {},
  speak(u) {
    spokenLog.push({ text: u.text, at: Date.now() });
    setTimeout(() => u.onend?.(), 20); // "đọc" mỗi câu mất 20 ms
  },
};

class FakeRecognition {
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    this.onstart?.();
  }
  abort() {}
}

/** Tạo sự kiện kết quả giống SpeechRecognition: danh sách [văn bản, đã chốt?]. */
function resultEvent(items, resultIndex = 0) {
  const results = items.map(([text, isFinal]) => Object.assign([{ transcript: text }], { isFinal }));
  return { resultIndex, results };
}

globalThis.window = { speechSynthesis: fakeSynth, SpeechSynthesisUtterance: FakeUtterance, SpeechRecognition: FakeRecognition };
globalThis.SpeechSynthesisUtterance = FakeUtterance;
const { Voice, Listener, isEchoOf } = await import("../audio-voice.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("đọc dần: câu đầu được đọc ngay, không chờ AI viết xong", async () => {
  spokenLog.length = 0;
  const voice = new Voice();
  const stream = voice.startStream();
  stream.push("Chào Đức.");
  await wait(5);
  assert.equal(spokenLog.length, 1, "câu đầu phải được đọc trước khi có câu thứ hai");
  await wait(40);
  stream.push("Hôm nay trời đẹp quá!");
  await stream.end();
  assert.deepEqual(spokenLog.map((s) => s.text), ["Chào Đức.", "Hôm nay trời đẹp quá!"]);
  assert.equal(voice.speaking, false);
});

test("đọc dần: bị ngắt thì dừng ngay, không đọc các câu còn lại", async () => {
  spokenLog.length = 0;
  const voice = new Voice();
  const stream = voice.startStream();
  stream.push("Câu một. Câu hai. Câu ba.");
  await wait(5);
  voice.stop();
  await stream.done;
  await wait(60);
  assert.equal(spokenLog.length, 1);
});

test("micro: chốt câu sớm khi chữ đứng yên, không gửi lặp khi trình duyệt chốt sau", async () => {
  const listener = new Listener();
  listener.earlyCommitMs = 30;
  const heard = [];
  listener.onFinal = (t) => heard.push(t);
  listener.start();
  const rec = FakeRecognition.last;
  rec.onresult(resultEvent([["mấy giờ rồi", false]]));
  await wait(50);
  assert.deepEqual(heard, ["mấy giờ rồi"]); // chốt sớm
  rec.onresult(resultEvent([["mấy giờ rồi", true]]));
  assert.deepEqual(heard, ["mấy giờ rồi"]); // không gửi lại
});

test("micro: ngập ngừng rồi nói tiếp -> gửi lại cả câu đầy đủ", async () => {
  const listener = new Listener();
  listener.earlyCommitMs = 30;
  const heard = [];
  listener.onFinal = (t) => heard.push(t);
  listener.start();
  const rec = FakeRecognition.last;
  rec.onresult(resultEvent([["kể cho tớ nghe", false]]));
  await wait(50);
  rec.onresult(resultEvent([["kể cho tớ nghe chuyện cổ tích", true]]));
  assert.deepEqual(heard, ["kể cho tớ nghe", "kể cho tớ nghe chuyện cổ tích"]);
});

test("micro: bỏ qua tiếng MTD vọng vào (kể cả phần đuôi tới sau khi MTD nói xong)", async () => {
  const listener = new Listener();
  listener.earlyCommitMs = 30;
  const heard = [];
  listener.onFinal = (t) => heard.push(t);
  listener.start();
  const rec = FakeRecognition.last;
  listener.pause(); // MTD bắt đầu nói
  rec.onresult(resultEvent([["xin chào tớ là", false]]));
  listener.resume(); // MTD nói xong
  rec.onresult(resultEvent([["xin chào tớ là MTD", true]])); // đuôi câu của MTD
  rec.onresult(resultEvent([["xin chào tớ là MTD", true], ["hát đi", true]], 1)); // người dùng nói
  // MTD nói câu khác, người dùng nói chen ngay khi MTD vừa dứt -> trình duyệt gộp chung một kết quả
  listener.pause();
  rec.onresult(resultEvent([["xin chào tớ là MTD", true], ["hát đi", true], ["xin chào tớ là", false]], 2));
  listener.resume();
  rec.onresult(resultEvent([["xin chào tớ là MTD", true], ["hát đi", true], ["xin chào tớ là mấy giờ rồi", true]], 2));
  await wait(50);
  // "MTD" là đuôi câu của chính MTD -> app.js lọc tiếp bằng isEchoOf (xem test bên dưới).
  assert.deepEqual(heard, ["MTD", "hát đi", "mấy giờ rồi"]);
});

test("lọc tiếng vọng: chữ nằm trong câu MTD vừa nói thì bỏ qua", () => {
  assert.equal(isEchoOf("MTD", "Xin chào, tớ là MTD!"), true);
  assert.equal(isEchoOf("là mtd", "Xin chào, tớ là MTD!"), true);
  assert.equal(isEchoOf("hát đi", "Xin chào, tớ là MTD!"), false);
});

test("PhoWhisper: bỏ các câu 'bịa' khi nghe tiếng ồn, giữ câu thật", async () => {
  const { cleanTranscript, rms } = await import("../stt.js");
  assert.equal(cleanTranscript("Hãy subscribe cho kênh nhé"), "");
  assert.equal(cleanTranscript("Cảm ơn các bạn đã theo dõi"), "");
  assert.equal(cleanTranscript(" ... "), "");
  assert.equal(cleanTranscript("  kể chuyện   cho tớ nghe "), "kể chuyện cho tớ nghe");
  assert.ok(rms(new Float32Array([0.5, -0.5])) > 0.4);
});

test("hát theo nốt: tốc độ phát luôn trong 0,8–1,25 để chữ rõ, vẫn giữ giai điệu lên xuống", async () => {
  const { singingRates } = await import("../neural-voice.js");
  const syl = (pitch) => ({ pitch });
  // Giọng nói ~180 Hz, giai điệu viết ở quãng cao (C5, E5, G5) -> cách cũ phải tua nhanh gần 2 lần.
  const rates = singingRates([syl(180), syl(180), syl(180)], ["C5", "E5", "G5"]);
  rates.forEach((r) => assert.ok(r >= 0.8 && r <= 1.25, `rate ${r}`));
  assert.ok(rates[0] < rates[1] && rates[1] < rates[2], "nốt cao hơn vẫn phải cao hơn");
  assert.deepEqual(singingRates([null], ["C5"]), [1]);
});
