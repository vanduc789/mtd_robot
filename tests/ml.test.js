// Kiểm thử v4.0: học máy (phân loại), trí nhớ dài hạn (RAG), tra cứu, di chuyển.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cosine, softmax, classify, MemoryStore, isMemorable, isKnowledgeQuestion, toSearchQuery } from "../nlp.js";
import { detectMove, semanticCommand, mlMood, describeRetrieved, Brain, DEFAULT_SETTINGS } from "../brain.js";

const readJSON = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf-8"));

test("softmax: tổng xác suất bằng 1, điểm cao nhất có xác suất cao nhất", () => {
  const p = softmax([2, 1, 0]);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(p[0] > p[1] && p[1] > p[2]);
});

test("bộ phân loại trong trình duyệt cho kết quả giống hệt scikit-learn", () => {
  const model = readJSON("../models/intent.json");
  for (const sample of readJSON("./fixtures/intent_check.json")) {
    const result = classify(model, sample.vector);
    assert.equal(result.label, sample.label, sample.text);
    assert.ok(Math.abs(result.prob - sample.prob) < 0.01, `${sample.text}: ${result.prob} vs ${sample.prob}`);
  }
});

test("mô hình cảm xúc xuất ra đúng 6 nhãn và kích thước 384 chiều", () => {
  const model = readJSON("../models/emotion.json");
  assert.deepEqual([...model.classes].sort(), ["angry", "anxious", "happy", "neutral", "sad", "surprised"]);
  assert.equal(model.weights[0].length, 384);
});

test("trí nhớ dài hạn: tìm ký ức gần nghĩa nhất, tách riêng từng người, bỏ trùng", () => {
  const fakeStorage = { data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = v; } };
  const store = new MemoryStore([], fakeStorage);
  const unit = (...xs) => { const n = Math.hypot(...xs); return xs.map((x) => x / n); };
  assert.equal(store.add("tớ có con mèo tên Mướp", "owner", unit(1, 0, 0)), true);
  assert.equal(store.add("tớ có con mèo tên Mướp nhé", "owner", unit(1, 0.01, 0)), false); // gần như trùng
  store.add("tớ thích bóng đá", "owner", unit(0, 1, 0));
  store.add("tớ là Nam, tớ thích cờ vua", "Nam", unit(1, 0, 0));
  const found = store.search(unit(0.98, 0.1, 0), "owner", { minScore: 0.9 });
  assert.equal(found.length, 1);
  assert.equal(found[0].text, "tớ có con mèo tên Mướp");
  store.save();
  assert.equal(new MemoryStore(null, fakeStorage).items.length, 3);
  assert.ok(Math.abs(cosine(unit(1, 0, 0), unit(1, 0, 0)) - 1) < 1e-9);
});

test("chỉ nhớ những câu kể về bản thân", () => {
  assert.equal(isMemorable("tớ có một con mèo tên là Mướp"), true);
  assert.equal(isMemorable("mẹ tớ là giáo viên dạy văn"), true);
  assert.equal(isMemorable("hát đi"), false);
  assert.equal(isMemorable("trời hôm nay đẹp quá nhỉ"), false);
});

test("nhận ra câu hỏi kiến thức và rút gọn từ khoá tìm kiếm", () => {
  assert.equal(isKnowledgeQuestion("MTD ơi lỗ đen là gì?"), true);
  assert.equal(isKnowledgeQuestion("tại sao lá cây màu xanh"), true);
  assert.equal(isKnowledgeQuestion("cậu là ai"), false); // hỏi về MTD, không tra cứu
  assert.equal(isKnowledgeQuestion("hôm nay tớ vui lắm"), false);
  assert.equal(toSearchQuery("MTD ơi cho tớ hỏi lỗ đen là gì?"), "lỗ đen");
});

test("lệnh di chuyển và nhào lộn", () => {
  assert.equal(detectMove("lộn vòng đi MTD")?.name, "flip");
  assert.equal(detectMove("nhào lộn ngang cho tớ xem")?.name, "cartwheel");
  assert.equal(detectMove("chạy một vòng đi")?.name, "patrol");
  assert.equal(detectMove("lăn sang trái")?.name, "left");
  assert.equal(detectMove("ngồi bên phải tớ là bạn Nam"), null);
});

test("ý định học máy chỉ được dùng khi đủ tự tin", () => {
  assert.equal(semanticCommand({ intent: "flip", intentProb: 0.8, intentThreshold: 0.5 }).move.name, "flip");
  assert.equal(semanticCommand({ intent: "flip", intentProb: 0.3, intentThreshold: 0.5 }), null);
  assert.equal(semanticCommand({ intent: "chat", intentProb: 0.99 }), null);
  assert.equal(semanticCommand({ intent: "sing", intentProb: 0.9 }).intent, "sing");
  assert.equal(mlMood({ mood: "sad", moodProb: 0.8 }), "sad");
  assert.equal(mlMood({ mood: "sad", moodProb: 0.4 }), null);
});

test("não nhận lệnh di chuyển theo nghĩa (không có từ khoá) nhờ học máy", async () => {
  const brain = new Brain({ ...DEFAULT_SETTINGS, provider: "offline" });
  const result = await brain.respond("làm một cú santo trên không xem nào", { nlp: { intent: "flip", intentProb: 0.61, intentThreshold: 0.5 } });
  assert.equal(result.action, "move");
});

test("RAG: ký ức và tài liệu được đưa vào prompt, không có AI thì đọc tóm tắt Wikipedia", async () => {
  const prompt = describeRetrieved(
    { memories: [{ text: "tớ có con mèo tên Mướp", t: Date.now() }], knowledge: [{ title: "Lỗ đen", text: "Lỗ đen là vùng không-thời gian..." }] },
    "Đức"
  );
  assert.match(prompt, /Mướp/);
  assert.match(prompt, /Lỗ đen/);
  const brain = new Brain({ ...DEFAULT_SETTINGS, provider: "offline" });
  const result = await brain.respond("lỗ đen là gì", { knowledge: [{ title: "Lỗ đen", text: "Lỗ đen là một vùng không-thời gian. Không gì thoát ra được. Câu thứ ba." }] });
  assert.match(result.text, /Wikipedia/);
  assert.doesNotMatch(result.text, /Câu thứ ba/);
});

test("link chia sẻ: key 'server-proxy' -> gọi Gemini qua server, KHÔNG gửi key nào lên mạng", async () => {
  const brain = new Brain({ ...DEFAULT_SETTINGS, provider: "gemini", keys: { ...DEFAULT_SETTINGS.keys, gemini: "server-proxy" } });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: options?.headers || {} });
    const sse = 'data: {"candidates":[{"content":{"parts":[{"text":"Xin chào bạn!"}]}}]}\n\n';
    return new Response(sse, { status: 200 });
  };
  try {
    const result = await brain.respond("chào bạn");
    assert.equal(result.text, "Xin chào bạn!");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(calls[0].url.startsWith("./api/gemini?model="), calls[0].url);
  assert.equal(calls[0].headers["x-goog-api-key"], undefined);
  assert.equal(await brain.pickGeminiModel(), brain.settings.models.gemini);
});
