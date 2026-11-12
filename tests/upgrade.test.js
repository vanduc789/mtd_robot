// Kiểm thử các tính năng v3.0: nhận diện khuôn mặt (phần so khớp), xấu hổ, hip-hop, chào gọi tên.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FaceBook, faceDistance, MATCH_THRESHOLD } from "../face-id.js";
import { detectCompliment, extractName, timeGreeting, detectIntent, detectGesture, describeViewer, Brain, DEFAULT_SETTINGS } from "../brain.js";

/** Tạo một "khuôn mặt giả" 128 số, cộng thêm nhiễu nhỏ để giống ảnh chụp ở góc khác. */
// Hai người khác nhau trong thực tế có khoảng cách ~0.8–1.2, nên mỗi "người giả" là một dãy số ngẫu nhiên riêng.
function fakeFace(seed, noise = 0) {
  let x = seed * 9301 + 49297;
  const next = () => ((x = (x * 9301 + 49297) % 233280) / 233280) - 0.5; // bộ sinh số ngẫu nhiên cố định theo seed
  return Array.from({ length: 128 }, () => next() * 0.35 + (Math.random() - 0.5) * noise);
}

test("sổ khuôn mặt: nhận ra chủ nhân, bạn bè và người lạ", () => {
  const book = new FaceBook();
  book.addPerson("Đức", [fakeFace(1), fakeFace(1, 0.01)], true);
  book.addPerson("Nam", [fakeFace(2)]);

  assert.equal(book.match(fakeFace(1, 0.02)).person.name, "Đức");
  assert.equal(book.match(fakeFace(1, 0.02)).person.isOwner, true);
  assert.equal(book.match(fakeFace(2, 0.02)).person.name, "Nam");
  assert.equal(book.match(fakeFace(7)), null); // người lạ
  assert.ok(faceDistance(fakeFace(1), fakeFace(7)) > MATCH_THRESHOLD);
});

test("sổ khuôn mặt: chỉ có một chủ nhân, bạn trùng tên thì gộp mẫu, đổi tên chủ nhân", () => {
  const book = new FaceBook();
  book.addPerson("A", [fakeFace(1)], true);
  book.addPerson("B", [fakeFace(3)], true); // quét lại chủ nhân -> thay người cũ
  assert.equal(book.people.filter((p) => p.isOwner).length, 1);
  assert.equal(book.owner().name, "B");

  book.addPerson("Nam", [fakeFace(2)]);
  book.addPerson("nam", [fakeFace(2, 0.01)]);
  assert.equal(book.friends().length, 1);
  assert.equal(book.friends()[0].descriptors.length, 2);

  book.renameOwner("Đức");
  assert.equal(book.owner().name, "Đức");
});

test("xấu hổ khi được khen, nhưng không nhầm câu phủ định", () => {
  assert.equal(detectCompliment("MTD dễ thương quá"), true);
  assert.equal(detectCompliment("cậu giỏi quá đi"), true);
  assert.equal(detectCompliment("tớ yêu cậu"), true);
  assert.equal(detectCompliment("cậu không đẹp đâu"), false);
  assert.equal(detectCompliment("hôm nay trời mưa"), false);
});

test("lấy tên người lạ tự giới thiệu", () => {
  assert.equal(extractName("tớ tên là minh anh"), "Minh Anh");
  assert.equal(extractName("Nam", true), "Nam");
  assert.equal(extractName("mình là Lan nhé", true), "Lan");
  assert.equal(extractName("không", true), null);
  assert.equal(extractName("hôm nay trời đẹp quá", true), null);
});

test("lời chào gọi đúng tên chủ nhân", () => {
  const evening = timeGreeting(new Date(2026, 0, 1, 19, 0), false, "Đức");
  assert.match(evening, /Đức/);
  assert.match(timeGreeting(new Date(2026, 0, 1, 14, 0), true, "Đức"), /Đức/);
  assert.doesNotMatch(timeGreeting(new Date(2026, 0, 1, 19, 0), false), /Đức/);
});

test("lệnh khuôn mặt và hip-hop", () => {
  assert.equal(detectIntent("MTD ơi nhớ mặt tớ nhé"), "face_learn");
  assert.equal(detectIntent("quên khuôn mặt đi"), "face_forget");
  assert.equal(detectIntent("cậu có nhận ra tớ không"), "who_am_i");
  assert.equal(detectGesture("nhảy hip hop cho tớ xem")?.name, "hiphop");
  assert.equal(detectGesture("nhay hiphop di")?.name, "hiphop");
  assert.equal(detectGesture("nhảy đi")?.name, "dance");
});

test("AI được báo đang nói chuyện với người lạ", () => {
  assert.match(describeViewer({ kind: "stranger", names: [] }, "Đức"), /NGƯỜI LẠ.*bạn thân của Đức/s);
  assert.match(describeViewer({ kind: "friend", names: ["Nam"] }, "Đức"), /Nam — bạn của Đức/);
  assert.equal(describeViewer(null, "Đức"), "");
});

test("người lạ nói 'tớ tên là ...' không làm đổi tên chủ nhân", async () => {
  const brain = new Brain({ ...DEFAULT_SETTINGS, provider: "offline", userName: "Đức" });
  await brain.respond("tớ tên là Nam", { viewer: { kind: "stranger", names: [] } });
  assert.equal(brain.settings.userName, "Đức");
});

test("không có AI: được khen thì trả lời ngượng ngùng", async () => {
  const brain = new Brain({ ...DEFAULT_SETTINGS, provider: "offline" });
  const result = await brain.respond("MTD đáng yêu quá");
  assert.equal(result.state, "shy");
});
