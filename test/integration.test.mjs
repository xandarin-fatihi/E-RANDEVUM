import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 43173;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const temp = mkdtempSync(join(tmpdir(), "e-randevum-test-"));
const dbPath = join(temp, "test.db");
let child;

async function request(path, { body, cookie, method = body ? "POST" : "GET" } = {}) {
  const response = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  return { response, payload, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

async function startServer() {
  child = spawn(process.execPath, ["server.mjs", "--reset-demo"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DB_PATH: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("test server timeout")), 8000);
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("E-Randevum hazır")) { clearTimeout(timer); resolve(); } });
    child.once("exit", (code) => reject(new Error(`test server exited ${code}`)));
  });
}

test.before(startServer);
test.after(async () => {
  if (child && !child.killed) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); }
  rmSync(temp, { recursive: true, force: true });
});

test("sağlık, uygunluk ve atomik tek kapasite tutma akışı", async () => {
  const health = await request("/api/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.payload.app, "E-Randevum");

  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 2 * 86_400_000));
  const available = await request(`/api/public/availability?isletme=yakupberber&date=${date}&serviceIds=1&staffId=1`);
  assert.equal(available.response.status, 200);
  assert.ok(available.payload.slots.length > 0);
  const startAt = available.payload.slots[0].startAt;

  const otpRequest = await request("/api/public/phone/request?isletme=yakupberber", { body: { phone: "0555 900 10 10" } });
  assert.equal(otpRequest.payload.mode, "demo");
  const otp = await request("/api/public/phone/confirm?isletme=yakupberber", { body: { phone: "0555 900 10 10", code: "123456" } });
  assert.ok(otp.payload.verificationToken);

  const holdBody = { fullName: "Test Müşteri", phone: "0555 900 10 10", verificationToken: otp.payload.verificationToken, serviceIds: [1], staffId: 1, startAt };
  const holds = await Promise.all([
    request("/api/public/holds?isletme=yakupberber", { body: holdBody }),
    request("/api/public/holds?isletme=yakupberber", { body: holdBody }),
  ]);
  const success = holds.find((item) => item.response.status === 201);
  const conflict = holds.find((item) => item.response.status === 409);
  assert.ok(success, "bir tutma başarılı olmalı");
  assert.ok(conflict, "aynı kapasitedeki ikinci tutma reddedilmeli");

  const payment = await request("/api/public/payments/mock-complete?isletme=yakupberber", { body: { holdToken: success.payload.holdToken, providerEventId: "evt_atomic_1" } });
  assert.equal(payment.payload.status, "pending_approval");
  const replay = await request("/api/public/payments/mock-complete?isletme=yakupberber", { body: { holdToken: success.payload.holdToken, providerEventId: "evt_atomic_1" } });
  assert.equal(replay.payload.idempotentReplay, true);

  const staffLogin = await request("/api/auth/login?isletme=yakupberber", { body: { username: "ahmet", password: "Usta123!", tenantSlug: "yakupberber", role: "staff" } });
  assert.equal(staffLogin.response.status, 200);
  const accept = await request(`/api/staff/appointments/${success.payload.appointmentId}/accept?isletme=yakupberber`, { body: {}, cookie: staffLogin.cookie });
  assert.equal(accept.payload.status, "confirmed");
});

test("yönetici raporu ve platform gizlilik sınırı ayrıdır", async () => {
  const adminLogin = await request("/api/auth/login?isletme=yakupberber", { body: { username: "yonetici", password: "Demo123!", tenantSlug: "yakupberber", role: "business_admin" } });
  const admin = await request("/api/admin/dashboard?isletme=yakupberber", { cookie: adminLogin.cookie });
  assert.equal(admin.response.status, 200);
  assert.ok(Array.isArray(admin.payload.customers));
  assert.ok("grossKurus" in admin.payload.revenue);

  const platformLogin = await request("/api/auth/login", { body: { username: "platform", password: "Platform123!", role: "platform_owner" } });
  const platform = await request("/api/platform/dashboard", { cookie: platformLogin.cookie });
  assert.equal(platform.response.status, 200);
  assert.ok(Array.isArray(platform.payload.tenants));
  assert.equal("customers" in platform.payload, false);
  assert.equal("revenue" in platform.payload, false);
  assert.match(platform.payload.privacyBoundary, /dahil edilmez/);
});
