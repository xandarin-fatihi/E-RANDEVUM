import { deflateSync } from "node:zlib";

const origin = process.env.APP_ORIGIN || "http://127.0.0.1:4173";
const slug = process.env.DEMO_TENANT_SLUG || "atlasbakim";

function assert(condition, message) { if (!condition) throw new Error(message); }

function demoLogoDataUrl() {
  const width = 64; const height = 64; const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1); raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const index = row + 1 + x * 4; const mark = (x >= 16 && x <= 46 && ((y >= 16 && y <= 22) || (y >= 29 && y <= 35) || (y >= 42 && y <= 48))) || (x >= 16 && x <= 22 && y >= 16 && y <= 48);
      const color = mark ? [232, 169, 72] : [20, 63, 58];
      raw[index] = color[0]; raw[index + 1] = color[1]; raw[index + 2] = color[2]; raw[index + 3] = 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const chunk = (type, data) => {
    const typeBytes = Buffer.from(type); const body = Buffer.concat([typeBytes, data]); let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); typeBytes.copy(out, 4); data.copy(out, 8); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length); return out;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function call(path, { body, cookie, expected = [200, 201] } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!expected.includes(response.status)) throw new Error(`${path}: ${response.status} ${payload.error?.message || JSON.stringify(payload)}`);
  return { payload, cookie: response.headers.get("set-cookie")?.split(";")[0], status: response.status };
}

const report = { steps: [] };

const platformLogin = await call("/api/auth/login", { body: { username: "platform", password: "Platform123!", role: "platform_owner" } });
report.steps.push("Platform sahibi oturumu açıldı");

let tenantId;
const platform = await call("/api/platform/dashboard", { cookie: platformLogin.cookie });
const prior = platform.payload.tenants.find((tenant) => tenant.slug === slug);
if (prior) tenantId = prior.id;
else {
  const created = await call("/api/platform/tenants", { cookie: platformLogin.cookie, body: { slug, name: "Atlas Bakım Stüdyosu", adminName: "Nehir Atlas", adminUsername: "atlasyonetici", initialPassword: "Atlas123!" } });
  tenantId = created.payload.tenantId;
  report.steps.push("Örnek işletme ve ilk yönetici platform tarafından oluşturuldu");
}
await call(`/api/platform/tenants/${tenantId}/subscription`, { cookie: platformLogin.cookie, body: { status: "active", endsAt: new Date(Date.now() + 60 * 86_400_000).toISOString() } });
report.steps.push("Sabit abonelik dışarıdan ödendi olarak 60 gün uzatıldı");

const adminLogin = await call(`/api/auth/login?isletme=${slug}`, { body: { username: "atlasyonetici", password: "Atlas123!", tenantSlug: slug, role: "business_admin" } });
const adminCookie = adminLogin.cookie;
await call(`/api/admin/branding/logo?isletme=${slug}`, { cookie: adminCookie, body: { dataUrl: demoLogoDataUrl() } });
report.steps.push("İşletme yöneticisi PNG logo yükledi");

let dashboard = await call(`/api/admin/dashboard?isletme=${slug}`, { cookie: adminCookie });
let service = dashboard.payload.services.find((item) => item.name === "Bakım Paketi");
if (!service) service = (await call(`/api/admin/services?isletme=${slug}`, { cookie: adminCookie, body: { name: "Bakım Paketi", priceTl: 300, durationMin: 30 } })).payload;
report.steps.push("300 TL / 30 dk örnek hizmet oluşturuldu");

dashboard = await call(`/api/admin/dashboard?isletme=${slug}`, { cookie: adminCookie });
for (const [name, username] of [["Ece Usta", "eceusta"], ["Can Usta", "canusta"]]) {
  if (!dashboard.payload.staff.some((item) => item.username === username)) {
    await call(`/api/admin/staff?isletme=${slug}`, { cookie: adminCookie, body: { name, username, initialPassword: "Usta123!", serviceIds: [service.id], color: username === "eceusta" ? "#2f7c72" : "#745a91" } });
  }
}
report.steps.push("İki personel hesabı ve hizmet yetkinliği oluşturuldu");

dashboard = await call(`/api/admin/dashboard?isletme=${slug}`, { cookie: adminCookie });
const staff = dashboard.payload.staff.filter((item) => ["eceusta", "canusta"].includes(item.username));
assert(staff.length === 2, "İki personel bulunamadı");

const bookingDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 3 * 86_400_000));
const availability = await call(`/api/public/availability?isletme=${slug}&date=${bookingDate}&serviceIds=${service.id}`);
assert(availability.payload.slots.length > 0, "Uygun saat bulunamadı");
const startAt = availability.payload.slots[0].startAt;

async function verifiedCustomer(phone) {
  await call(`/api/public/phone/request?isletme=${slug}`, { body: { phone } });
  return (await call(`/api/public/phone/confirm?isletme=${slug}`, { body: { phone, code: "123456" } })).payload.verificationToken;
}

const poolPhone = "0555 700 10 01"; const poolVerification = await verifiedCustomer(poolPhone);
const poolHold = await call(`/api/public/holds?isletme=${slug}`, { body: { fullName: "Deniz Akın", phone: poolPhone, verificationToken: poolVerification, serviceIds: [service.id], staffId: null, startAt } });
assert(poolHold.payload.calculation.depositKurus === 9000, "300 TL için yüzde 30 kapora 90 TL olmalı");

const directPhone = "0555 700 10 02"; const directVerification = await verifiedCustomer(directPhone);
const directHold = await call(`/api/public/holds?isletme=${slug}`, { body: { fullName: "Ekin Akın", phone: directPhone, verificationToken: directVerification, serviceIds: [service.id], staffId: staff[1].id, startAt } });
assert(directHold.status === 201, "Havuz talebi diğer personelin kapasitesini kapatmamalı");
report.steps.push("Aynı saatte havuz + diğer personele doğrudan tutma başarılı; havuz yalnız bir kapasite tüketti");

const payment = await call(`/api/public/payments/mock-complete?isletme=${slug}`, { body: { holdToken: poolHold.payload.holdToken, providerEventId: `role_flow_${Date.now()}` } });
assert(payment.payload.status === "pending_approval", "Ödeme sonrası onay beklenmeli");

const staffLogin = await call(`/api/auth/login?isletme=${slug}`, { body: { username: "eceusta", password: "Usta123!", tenantSlug: slug, role: "staff" } });
const staffDash = await call(`/api/staff/dashboard?isletme=${slug}`, { cookie: staffLogin.cookie });
const poolAppointment = staffDash.payload.appointments.find((item) => item.id === poolHold.payload.appointmentId);
assert(poolAppointment, "Havuz randevusu uygun personele görünmeli");
await call(`/api/staff/appointments/${poolHold.payload.appointmentId}/accept?isletme=${slug}`, { cookie: staffLogin.cookie, body: {} });
report.steps.push("Personel havuz randevusunu atomik olarak kabul etti");

const cancellation = await call(`/api/public/appointments/${poolHold.payload.appointmentId}/cancel?isletme=${slug}`, { body: { manageToken: poolHold.payload.manageToken } });
assert(cancellation.payload.outcome.refundKurus === 30000 && cancellation.payload.outcome.retainedKurus === 0, "Erken iptal tam iade olmalı");
report.steps.push("Müşteri erken iptal etti; 300 TL tam iade ve 0 TL kesinti doğrulandı");

const finalAdmin = await call(`/api/admin/dashboard?isletme=${slug}`, { cookie: adminCookie });
assert(finalAdmin.payload.audit.some((item) => item.eventType === "customer_cancelled"), "İptal audit kaydı eksik");
assert(finalAdmin.payload.tenant.hasLogo === true, "Logo kaydı görünmüyor");
report.tenant = { id: tenantId, slug, name: finalAdmin.payload.tenant.name };
report.result = "PASS";
console.log(JSON.stringify(report, null, 2));
