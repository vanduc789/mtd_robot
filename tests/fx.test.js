// Kiểm thử v4.2: hình học tia laze và lệnh bắn laze / biến hình.
import { test } from "node:test";
import assert from "node:assert/strict";
import { beamGeometry, extend } from "../fx.js";
import { detectMove } from "../brain.js";

test("tia laze: tính đúng độ dài và góc bắn", () => {
  const right = beamGeometry({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.equal(right.length, 100);
  assert.equal(right.angle, 0);
  const down = beamGeometry({ x: 0, y: 0 }, { x: 0, y: 50 });
  assert.equal(down.angle, 90); // trục y của màn hình hướng xuống
});

test("pháo tay: kéo dài tia theo hướng vai -> tay", () => {
  const end = extend({ x: 0, y: 0 }, { x: 10, y: 0 }, 500);
  assert.deepEqual(end, { x: 510, y: 0 });
});

test("lệnh laze và biến hình (dạng cụ thể được ưu tiên hơn 'biến hình' chung)", () => {
  assert.equal(detectMove("bắn laze đi MTD")?.name, "laser");
  assert.equal(detectMove("cậu có bắn tia laser được không")?.name, "laser");
  assert.equal(detectMove("biến hình đi")?.name, "transform");
  assert.equal(detectMove("biến hình thành xe đua đi")?.name, "transform-car");
  assert.equal(detectMove("bật chế độ chiến đấu")?.name, "transform-battle");
  assert.equal(detectMove("trở lại bình thường đi")?.name, "transform-normal");
});
