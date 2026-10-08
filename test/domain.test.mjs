import test from "node:test";
import assert from "node:assert/strict";
import { calculateReservation, cancellationOutcome, normalizePhone } from "../src/domain.mjs";
import { hashPassword, verifyPassword } from "../src/security.mjs";

test("hizmet süresi + pay sonraki 15 dakikaya yuvarlanır", () => {
  const result = calculateReservation([
    { duration_min: 25, price_kurus: 12000 },
    { duration_min: 30, price_kurus: 18000 },
  ], 7, 30);
  assert.deepEqual(result, {
    serviceMinutes: 55,
    bufferMinutes: 7,
    reservedMinutes: 75,
    totalPriceKurus: 30000,
    depositKurus: 9000,
  });
});

test("300 TL ve yüzde 30 kapora iade matrisi doğrudur", () => {
  const startAt = new Date("2026-10-09T12:00:00Z");
  const early = cancellationOutcome({ now: new Date("2026-10-09T07:59:00Z"), startAt, cutoffHours: 4, totalKurus: 30000, depositKurus: 9000 });
  const late = cancellationOutcome({ now: new Date("2026-10-09T08:00:00Z"), startAt, cutoffHours: 4, totalKurus: 30000, depositKurus: 9000 });
  const noShow = cancellationOutcome({ now: new Date("2026-10-09T12:01:00Z"), startAt, cutoffHours: 4, totalKurus: 30000, depositKurus: 9000 });
  assert.deepEqual(early, { kind: "free_cancel", refundKurus: 30000, retainedKurus: 0 });
  assert.deepEqual(late, { kind: "late_cancel", refundKurus: 21000, retainedKurus: 9000 });
  assert.deepEqual(noShow, { kind: "no_show", refundKurus: 0, retainedKurus: 30000 });
});

test("telefon normalize edilir ve şifre düz metin saklanmaz", () => {
  assert.equal(normalizePhone("0555 111 22 33"), "+905551112233");
  const encoded = hashPassword("Demo123!");
  assert.ok(encoded.startsWith("scrypt$"));
  assert.ok(!encoded.includes("Demo123!"));
  assert.equal(verifyPassword("Demo123!", encoded), true);
  assert.equal(verifyPassword("yanlis", encoded), false);
});
