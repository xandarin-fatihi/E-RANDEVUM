import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, withImmediateTransaction } from "./src/database.mjs";
import { calculateReservation, cancellationOutcome, normalizePhone } from "./src/domain.mjs";
import { clearSessionCookie, hashPassword, newToken, parseCookies, sessionCookie, tokenHash, verifyPassword } from "./src/security.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DATA_FILE = process.env.DB_PATH || join(ROOT, "data", "e-randevum.db");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const db = createDatabase(DATA_FILE, { reset: process.argv.includes("--reset-demo") });

class AppError extends Error {
  constructor(status, message, code = "REQUEST_ERROR", detail = undefined) {
    super(message); this.status = status; this.code = code; this.detail = detail;
  }
}

const mime = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
};

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(payload));
}

function audit(tenantId, appointmentId, actorUserId, eventType, detail = {}) {
  db.prepare("INSERT INTO audit_events(tenant_id,appointment_id,actor_user_id,event_type,detail_json,created_at) VALUES(?,?,?,?,?,?)")
    .run(tenantId ?? null, appointmentId ?? null, actorUserId ?? null, eventType, JSON.stringify(detail), new Date().toISOString());
}

function notify({ tenantId, userId = null, customerId = null, appointmentId = null, kind, title, body, requiresAction = false, dedupeKey }) {
  db.prepare(`INSERT OR IGNORE INTO notifications
    (tenant_id,user_id,customer_id,appointment_id,kind,title,body,requires_action,dedupe_key,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(tenantId, userId, customerId, appointmentId, kind, title, body, requiresAction ? 1 : 0, dedupeKey, new Date().toISOString());
}

function getTenantBySlug(slug = "yakupberber") {
  return db.prepare("SELECT * FROM tenants WHERE slug=?").get(String(slug).toLowerCase());
}

function resolveTenant(req, url) {
  const querySlug = url.searchParams.get("isletme");
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  let slug = querySlug;
  if (!slug && host.endsWith(".e-randevu.com")) slug = host.slice(0, -".e-randevu.com".length);
  if (!slug && host.endsWith(".e-randevum.com")) slug = host.slice(0, -".e-randevum.com".length);
  const tenant = getTenantBySlug(slug || "yakupberber");
  if (!tenant) throw new AppError(404, "İşletme bulunamadı", "TENANT_NOT_FOUND");
  return tenant;
}

function publicTenant(tenant) {
  return {
    id: tenant.id, slug: tenant.slug, name: tenant.name, appName: tenant.app_name, logoText: tenant.logo_text, hasLogo: Boolean(tenant.logo_data_url),
    faviconText: tenant.favicon_text, primaryColor: tenant.primary_color, accentColor: tenant.accent_color,
    bufferMinutes: tenant.buffer_minutes, depositRate: tenant.deposit_rate, cancellationHours: tenant.cancellation_hours,
    approvalMinutes: tenant.approval_minutes, graceMinutes: tenant.grace_minutes,
    subscriptionActive: tenant.subscription_status === "active" && new Date(tenant.subscription_ends_at) > new Date(),
    integration: { payment: "demo", sms: "demo", push: "in_app_ready_web_push_not_configured" },
  };
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256_000) throw new AppError(413, "İstek çok büyük", "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError(400, "Geçersiz JSON", "INVALID_JSON"); }
}

function authenticate(req) {
  const token = parseCookies(req.headers.cookie).er_session;
  if (!token) return null;
  return db.prepare(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(tokenHash(token), new Date().toISOString()) || null;
}

function requireUser(req, roles = []) {
  const user = authenticate(req);
  if (!user) throw new AppError(401, "Oturum açmanız gerekiyor", "AUTH_REQUIRED");
  if (roles.length && !roles.includes(user.role)) throw new AppError(403, "Bu işlem için yetkiniz yok", "FORBIDDEN");
  return user;
}

function assertTenantAccess(user, tenantId) {
  if (user.role === "platform_owner" || Number(user.tenant_id) !== Number(tenantId)) throw new AppError(404, "Kayıt bulunamadı", "NOT_FOUND");
}

function staffForUser(user) {
  const staff = db.prepare("SELECT * FROM staff_profiles WHERE user_id=? AND active=1").get(user.id);
  if (!staff) throw new AppError(403, "Aktif personel profili bulunamadı", "STAFF_INACTIVE");
  return staff;
}

function servicesForAppointment(appointmentId) {
  return db.prepare("SELECT service_id AS id,name_snapshot AS name,price_kurus_snapshot AS priceKurus,duration_min_snapshot AS durationMin FROM appointment_services WHERE appointment_id=?").all(appointmentId);
}

function shapeAppointment(row) {
  return {
    ...row,
    services: servicesForAppointment(row.id),
    eligibleStaffIds: JSON.parse(row.eligible_staff_json || "[]"),
    eligible_staff_json: undefined,
  };
}

function expireAndSchedule() {
  const now = new Date(); const nowIso = now.toISOString();
  const expiredHolds = db.prepare("SELECT * FROM appointments WHERE status='held' AND hold_expires_at<=?").all(nowIso);
  for (const apt of expiredHolds) {
    db.prepare("UPDATE appointments SET status='expired',updated_at=? WHERE id=? AND status='held'").run(nowIso, apt.id);
    audit(apt.tenant_id, apt.id, null, "hold_expired", { releasedAt: nowIso });
  }

  const approvalExpired = db.prepare("SELECT * FROM appointments WHERE status='pending_approval' AND approval_expires_at IS NOT NULL AND approval_expires_at<=?").all(nowIso);
  for (const apt of approvalExpired) {
    withImmediateTransaction(db, () => {
      const changed = db.prepare("UPDATE appointments SET status='cancelled',cancellation_kind='approval_timeout',cancellation_actor='system',refund_kurus=charge_kurus,retained_kurus=0,updated_at=? WHERE id=? AND status='pending_approval'").run(nowIso, apt.id);
      if (!changed.changes) return;
      db.prepare("UPDATE payments SET status='fully_refunded',refund_kurus=amount_kurus,updated_at=? WHERE appointment_id=?").run(nowIso, apt.id);
      notify({ tenantId: apt.tenant_id, customerId: apt.customer_id, appointmentId: apt.id, kind: "approval_timeout", title: "Onay süresi doldu", body: "Randevu iptal edildi; demo ödemede tam iade iş akışı tamamlandı.", dedupeKey: `approval-timeout-customer-${apt.id}` });
      audit(apt.tenant_id, apt.id, null, "approval_timeout_full_refund", { refundKurus: apt.charge_kurus });
    });
  }

  const toleranceRows = db.prepare("SELECT a.*,t.grace_minutes FROM appointments a JOIN tenants t ON t.id=a.tenant_id WHERE a.status='confirmed' AND a.attendance_status='pending' AND a.start_at<=?").all(nowIso);
  for (const apt of toleranceRows) {
    const dueAt = new Date(new Date(apt.start_at).getTime() + apt.grace_minutes * 60_000);
    if (now < dueAt) continue;
    withImmediateTransaction(db, () => {
      const changed = db.prepare("UPDATE appointments SET status='no_show',attendance_status='auto_no_show',attendance_score_applied=1,retained_kurus=charge_kurus,updated_at=? WHERE id=? AND status='confirmed' AND attendance_status='pending'").run(nowIso, apt.id);
      if (!changed.changes) return;
      db.prepare("UPDATE customers SET no_show_score=no_show_score+1 WHERE id=?").run(apt.customer_id);
      const staffUser = db.prepare("SELECT user_id FROM staff_profiles WHERE id=COALESCE(?,?)").get(apt.staff_id, apt.capacity_staff_id);
      notify({ tenantId: apt.tenant_id, userId: staffUser?.user_id, appointmentId: apt.id, kind: "attendance_unresolved", title: "Müşteri geldi mi?", body: "Tolerans süresi geçti. Sistem geçici olarak ‘gelmedi’ kaydetti; Geldi/Gelmedi ile kesinleştirin.", requiresAction: true, dedupeKey: `attendance-action-${apt.id}` });
      audit(apt.tenant_id, apt.id, null, "auto_no_show", { graceMinutes: apt.grace_minutes });
    });
  }

  const scheduleRows = db.prepare("SELECT * FROM appointments WHERE status='confirmed' AND start_at>? AND start_at<?").all(new Date(now.getTime() - 3_600_000).toISOString(), new Date(now.getTime() + 25 * 3_600_000).toISOString());
  for (const apt of scheduleRows) {
    const start = new Date(apt.start_at); const cutoff = new Date(apt.cancel_cutoff_at);
    for (const lead of [60, 30]) if (now >= new Date(start.getTime() - lead * 60_000) && now < start) {
      notify({ tenantId: apt.tenant_id, customerId: apt.customer_id, appointmentId: apt.id, kind: `customer_reminder_${lead}`, title: `Randevunuza ${lead} dakika kaldı`, body: "Saat ve hizmet ayrıntılarını E‑Randevum’dan kontrol edebilirsiniz.", dedupeKey: `reminder-${lead}-${apt.id}` });
    }
    for (const lead of [10, 5]) if (now >= new Date(cutoff.getTime() - lead * 60_000) && now < cutoff) {
      notify({ tenantId: apt.tenant_id, customerId: apt.customer_id, appointmentId: apt.id, kind: `cutoff_warning_${lead}`, title: `Ücretsiz iptal sınırına ${lead} dakika`, body: "Sınırdan sonra iptalde kapora oranı kesilir, kalan tutar iade edilir.", dedupeKey: `cutoff-${lead}-${apt.id}` });
    }
    const staffUser = db.prepare("SELECT user_id FROM staff_profiles WHERE id=COALESCE(?,?)").get(apt.staff_id, apt.capacity_staff_id);
    if (now >= new Date(start.getTime() - 5 * 60_000) && now < start) {
      notify({ tenantId: apt.tenant_id, userId: staffUser?.user_id, appointmentId: apt.id, kind: "staff_prepare", title: "5 dakika sonra randevunuz var", body: `${apt.customer_name_snapshot} için hazırlık zamanı.`, dedupeKey: `staff-prepare-${apt.id}` });
    }
    if (now >= start) {
      notify({ tenantId: apt.tenant_id, userId: staffUser?.user_id, appointmentId: apt.id, kind: "attendance_unresolved", title: "Müşteri geldi mi?", body: "Geldi veya Gelmedi seçimi yapılana kadar bu görev kapanmaz.", requiresAction: true, dedupeKey: `attendance-action-${apt.id}` });
    }
  }
}

function subscriptionOpen(tenant) {
  return tenant.subscription_status === "active" && new Date(tenant.subscription_ends_at) > new Date();
}

function getSelectedServices(tenantId, serviceIds) {
  const ids = [...new Set((serviceIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw new AppError(400, "En az bir hizmet seçin", "SERVICE_REQUIRED");
  const marks = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM services WHERE tenant_id=? AND active=1 AND id IN (${marks})`).all(tenantId, ...ids);
  if (rows.length !== ids.length) throw new AppError(400, "Seçilen hizmetlerden biri kullanılamıyor", "SERVICE_INVALID");
  return rows;
}

function capableStaff(tenantId, serviceIds, requestedStaffId = null) {
  const marks = serviceIds.map(() => "?").join(",");
  const rows = db.prepare(`SELECT sp.* FROM staff_profiles sp
    JOIN users u ON u.id=sp.user_id AND u.active=1
    JOIN staff_services ss ON ss.staff_id=sp.id
    WHERE sp.tenant_id=? AND sp.active=1 ${requestedStaffId ? "AND sp.id=?" : ""} AND ss.service_id IN (${marks})
    GROUP BY sp.id HAVING COUNT(DISTINCT ss.service_id)=? ORDER BY sp.id`).all(tenantId, ...(requestedStaffId ? [Number(requestedStaffId)] : []), ...serviceIds, serviceIds.length);
  return rows;
}

function istanbulParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Istanbul", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: dayMap[map.weekday], minutes: Number(map.hour) * 60 + Number(map.minute) };
}

function isWithinWorkingHours(staff, startAt, endAt) {
  const start = istanbulParts(new Date(startAt)); const end = istanbulParts(new Date(new Date(endAt).getTime() - 1));
  if (start.day !== end.day) return false;
  const intervals = JSON.parse(staff.weekly_hours_json || "{}")[start.day] || [];
  return intervals.some(([from, to]) => {
    const [fh, fm] = from.split(":").map(Number); const [th, tm] = to.split(":").map(Number);
    return start.minutes >= fh * 60 + fm && end.minutes < th * 60 + tm;
  });
}

function staffHasConflict(tenantId, staffId, startAt, endAt, excludeAppointmentId = 0) {
  return Boolean(db.prepare(`SELECT 1 FROM appointments WHERE tenant_id=? AND capacity_staff_id=? AND id<>?
    AND status IN ('held','pending_approval','confirmed') AND start_at<? AND end_at>?
    AND (status<>'held' OR hold_expires_at>?) LIMIT 1`).get(tenantId, staffId, excludeAppointmentId, endAt, startAt, new Date().toISOString()));
}

function availableStaffAt(tenantId, candidates, startAt, endAt, excludeAppointmentId = 0) {
  return candidates.filter((staff) => isWithinWorkingHours(staff, startAt, endAt) && !staffHasConflict(tenantId, staff.id, startAt, endAt, excludeAppointmentId));
}

function appointmentDetailsByToken(token) {
  if (!token) throw new AppError(401, "Randevu yönetim kodu gerekli", "MANAGE_TOKEN_REQUIRED");
  const row = db.prepare(`SELECT a.*,sp.name AS staff_name, t.name AS tenant_name,t.slug AS tenant_slug
    FROM appointments a JOIN tenants t ON t.id=a.tenant_id LEFT JOIN staff_profiles sp ON sp.id=a.staff_id
    WHERE a.manage_token_hash=?`).get(tokenHash(token));
  if (!row) throw new AppError(404, "Randevu bulunamadı", "NOT_FOUND");
  return row;
}

function applyRefund(appointment, refundKurus, status) {
  const now = new Date().toISOString();
  db.prepare("UPDATE payments SET status=?,refund_kurus=?,updated_at=? WHERE appointment_id=?")
    .run(status, refundKurus, now, appointment.id);
}

async function handleApi(req, res, url) {
  expireAndSchedule();
  const method = req.method || "GET"; const path = url.pathname;

  if (method === "GET" && path === "/api/health") {
    return sendJson(res, 200, { ok: true, app: "E-Randevum", database: "sqlite", time: new Date().toISOString() });
  }

  if (method === "GET" && path === "/api/public/bootstrap") {
    const tenant = resolveTenant(req, url);
    const services = db.prepare("SELECT id,name,price_kurus AS priceKurus,duration_min AS durationMin FROM services WHERE tenant_id=? AND active=1 ORDER BY id").all(tenant.id);
    const staff = db.prepare("SELECT id,name,color FROM staff_profiles WHERE tenant_id=? AND active=1 ORDER BY id").all(tenant.id);
    return sendJson(res, 200, { tenant: publicTenant(tenant), services, staff, rules: { multiServiceSingleProfessional: true, holdMinutes: 5, fullPrepayment: true } });
  }

  if (method === "GET" && path === "/api/public/logo") {
    const tenant = resolveTenant(req, url);
    if (!tenant.logo_data_url) throw new AppError(404, "İşletme logosu yok", "LOGO_NOT_FOUND");
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(tenant.logo_data_url);
    if (!match) throw new AppError(415, "Logo biçimi desteklenmiyor", "LOGO_INVALID");
    const bytes = Buffer.from(match[2], "base64");
    res.writeHead(200, { "Content-Type": match[1], "Content-Length": bytes.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(bytes); return;
  }

  if (method === "GET" && path === "/api/public/availability") {
    const tenant = resolveTenant(req, url);
    if (!subscriptionOpen(tenant)) throw new AppError(403, "Abonelik süresi dolduğu için yeni randevu kapalı", "SUBSCRIPTION_EXPIRED");
    const date = url.searchParams.get("date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new AppError(400, "Geçerli tarih seçin", "DATE_REQUIRED");
    const serviceIds = (url.searchParams.get("serviceIds") || "").split(",").filter(Boolean).map(Number);
    const services = getSelectedServices(tenant.id, serviceIds);
    const staffId = url.searchParams.get("staffId") || null;
    const candidates = capableStaff(tenant.id, serviceIds, staffId);
    const calc = calculateReservation(services, tenant.buffer_minutes, tenant.deposit_rate);
    const slots = [];
    for (let minute = 9 * 60; minute <= 20 * 60 - calc.reservedMinutes; minute += 15) {
      const hh = String(Math.floor(minute / 60)).padStart(2, "0"); const mm = String(minute % 60).padStart(2, "0");
      const startAt = new Date(`${date}T${hh}:${mm}:00+03:00`).toISOString();
      if (new Date(startAt) <= new Date(Date.now() + 5 * 60_000)) continue;
      const serviceEndAt = new Date(new Date(startAt).getTime() + calc.serviceMinutes * 60_000).toISOString();
      const endAt = new Date(new Date(startAt).getTime() + calc.reservedMinutes * 60_000).toISOString();
      const available = availableStaffAt(tenant.id, candidates, startAt, endAt);
      if (available.length) slots.push({ startAt, serviceEndAt, endAt, availableStaff: available.map(({ id, name, color }) => ({ id, name, color })) });
    }
    return sendJson(res, 200, { slots, calculation: calc, candidates: candidates.map(({ id, name, color }) => ({ id, name, color })) });
  }

  if (method === "POST" && path === "/api/public/phone/request") {
    const tenant = resolveTenant(req, url); const body = await readBody(req); const phone = normalizePhone(body.phone);
    const now = new Date(); const code = "123456";
    db.prepare("INSERT INTO phone_verifications(tenant_id,phone,code_hash,expires_at,created_at) VALUES(?,?,?,?,?)")
      .run(tenant.id, phone, tokenHash(code), new Date(now.getTime() + 10 * 60_000).toISOString(), now.toISOString());
    return sendJson(res, 200, { ok: true, mode: "demo", demoCode: code, message: "Demo modunda gerçek SMS gönderilmedi. Kod: 123456" });
  }

  if (method === "POST" && path === "/api/public/phone/confirm") {
    const tenant = resolveTenant(req, url); const body = await readBody(req); const phone = normalizePhone(body.phone); const now = new Date().toISOString();
    const row = db.prepare("SELECT * FROM phone_verifications WHERE tenant_id=? AND phone=? AND code_hash=? AND expires_at>? ORDER BY id DESC LIMIT 1")
      .get(tenant.id, phone, tokenHash(body.code), now);
    if (!row) throw new AppError(400, "Kod geçersiz veya süresi dolmuş", "OTP_INVALID");
    const token = newToken();
    db.prepare("UPDATE phone_verifications SET token_hash=?,verified_at=? WHERE id=?").run(tokenHash(token), now, row.id);
    return sendJson(res, 200, { ok: true, verificationToken: token, phone, mode: "demo" });
  }

  if (method === "POST" && path === "/api/public/holds") {
    const tenant = resolveTenant(req, url); const body = await readBody(req);
    if (!subscriptionOpen(tenant)) throw new AppError(403, "Abonelik süresi dolduğu için yeni randevu kapalı", "SUBSCRIPTION_EXPIRED");
    const fullName = String(body.fullName || "").trim();
    if (fullName.length < 3 || fullName.length > 100) throw new AppError(400, "Ad soyad girin", "NAME_REQUIRED");
    const phone = normalizePhone(body.phone); const now = new Date();
    const verification = db.prepare("SELECT 1 FROM phone_verifications WHERE tenant_id=? AND phone=? AND token_hash=? AND verified_at IS NOT NULL AND expires_at>? LIMIT 1")
      .get(tenant.id, phone, tokenHash(body.verificationToken || ""), now.toISOString());
    if (!verification) throw new AppError(400, "Telefonu demo koduyla doğrulayın", "PHONE_NOT_VERIFIED");
    const services = getSelectedServices(tenant.id, body.serviceIds); const serviceIds = services.map((item) => item.id);
    const calc = calculateReservation(services, tenant.buffer_minutes, tenant.deposit_rate);
    const startAt = new Date(body.startAt);
    if (!Number.isFinite(startAt.getTime()) || startAt <= new Date(now.getTime() + 60_000)) throw new AppError(400, "Geçerli ileri bir saat seçin", "START_INVALID");
    const serviceEndAt = new Date(startAt.getTime() + calc.serviceMinutes * 60_000).toISOString();
    const endAt = new Date(startAt.getTime() + calc.reservedMinutes * 60_000).toISOString();
    const requestedStaffId = body.staffId ? Number(body.staffId) : null;
    const candidates = capableStaff(tenant.id, serviceIds, requestedStaffId);
    if (!candidates.length) throw new AppError(409, "Tüm hizmetleri yapabilen uygun çalışan yok", "NO_CAPABLE_STAFF");
    const holdToken = newToken(); const manageToken = newToken();
    const result = withImmediateTransaction(db, () => {
      const available = availableStaffAt(tenant.id, candidates, startAt.toISOString(), endAt);
      if (!available.length) throw new AppError(409, "Bu saat az önce doldu; başka bir saat seçin", "SLOT_CONFLICT");
      const capacityStaff = available[0];
      let customer = db.prepare("SELECT * FROM customers WHERE tenant_id=? AND phone=?").get(tenant.id, phone);
      if (customer) {
        db.prepare("UPDATE customers SET full_name=?,phone_verified=1,phone_verification_mode='demo' WHERE id=?").run(fullName, customer.id);
      } else {
        const id = Number(db.prepare("INSERT INTO customers(tenant_id,full_name,phone,phone_verified,phone_verification_mode,created_at) VALUES(?,?,?,?,?,?)")
          .run(tenant.id, fullName, phone, 1, "demo", now.toISOString()).lastInsertRowid);
        customer = db.prepare("SELECT * FROM customers WHERE id=?").get(id);
      }
      const holdExpiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
      const cutoffAt = new Date(startAt.getTime() - tenant.cancellation_hours * 3_600_000).toISOString();
      const appointmentId = Number(db.prepare(`INSERT INTO appointments
        (tenant_id,customer_id,staff_id,capacity_staff_id,eligible_staff_json,selection_mode,status,start_at,service_end_at,end_at,total_service_minutes,buffer_minutes,reserved_minutes,charge_kurus,deposit_kurus,hold_token_hash,manage_token_hash,hold_expires_at,cancel_cutoff_at,customer_name_snapshot,customer_phone_snapshot,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          tenant.id, customer.id, requestedStaffId, capacityStaff.id, JSON.stringify(candidates.map((item) => item.id)), requestedStaffId ? "direct" : "pool", "held",
          startAt.toISOString(), serviceEndAt, endAt, calc.serviceMinutes, calc.bufferMinutes, calc.reservedMinutes, calc.totalPriceKurus, calc.depositKurus,
          tokenHash(holdToken), tokenHash(manageToken), holdExpiresAt, cutoffAt, fullName, phone, now.toISOString(), now.toISOString()
        ).lastInsertRowid);
      const insertSnapshot = db.prepare("INSERT INTO appointment_services(appointment_id,service_id,name_snapshot,price_kurus_snapshot,duration_min_snapshot) VALUES(?,?,?,?,?)");
      for (const service of services) insertSnapshot.run(appointmentId, service.id, service.name, service.price_kurus, service.duration_min);
      audit(tenant.id, appointmentId, null, "slot_held", { capacityStaffId: capacityStaff.id, eligibleStaffIds: candidates.map((item) => item.id), expiresAt: holdExpiresAt });
      return { appointmentId, holdExpiresAt };
    });
    return sendJson(res, 201, { ...result, holdToken, manageToken, calculation: calc, payment: { mode: "demo_hosted_adapter", amountKurus: calc.totalPriceKurus, cardDataAccepted: false } });
  }

  if (method === "POST" && path === "/api/public/payments/mock-complete") {
    const body = await readBody(req);
    if (Object.keys(body).some((key) => /card|pan|cvv|cvc|expiry/i.test(key))) throw new AppError(400, "Kart verisi bu sunucuya gönderilemez", "CARD_DATA_FORBIDDEN");
    const holdHash = tokenHash(body.holdToken || ""); const eventId = String(body.providerEventId || `demo_${newToken(12)}`);
    const existingEvent = db.prepare("SELECT result_json FROM provider_events WHERE provider='demo' AND event_id=?").get(eventId);
    if (existingEvent) return sendJson(res, 200, { ...JSON.parse(existingEvent.result_json), idempotentReplay: true });
    const result = withImmediateTransaction(db, () => {
      const apt = db.prepare("SELECT * FROM appointments WHERE hold_token_hash=?").get(holdHash);
      if (!apt) throw new AppError(404, "Ödeme siparişi bulunamadı", "HOLD_NOT_FOUND");
      const now = new Date();
      if (apt.status !== "held" || new Date(apt.hold_expires_at) <= now) {
        if (apt.status === "held") db.prepare("UPDATE appointments SET status='expired',updated_at=? WHERE id=?").run(now.toISOString(), apt.id);
        const paymentRef = `demo_late_${apt.id}_${eventId}`;
        db.prepare(`INSERT INTO payments(tenant_id,appointment_id,provider,provider_payment_ref,amount_kurus,status,refund_kurus,created_at,updated_at)
          VALUES(?,?,?,?,?,'fully_refunded',?,?,?) ON CONFLICT(appointment_id) DO UPDATE SET status='fully_refunded',refund_kurus=excluded.refund_kurus,updated_at=excluded.updated_at`)
          .run(apt.tenant_id, apt.id, "demo", paymentRef, apt.charge_kurus, apt.charge_kurus, now.toISOString(), now.toISOString());
        db.prepare("UPDATE appointments SET refund_kurus=charge_kurus,retained_kurus=0,updated_at=? WHERE id=?").run(now.toISOString(), apt.id);
        const payload = { status: "fully_refunded", reason: "late_payment_after_hold", appointmentId: apt.id, refundKurus: apt.charge_kurus, message: "Saat yeniden rezervasyona açıldığı için ikinci randevu oluşturulmadı; tam iade iş akışı uygulandı." };
        db.prepare("INSERT INTO provider_events(provider,event_id,appointment_id,result_json,created_at) VALUES('demo',?,?,?,?)").run(eventId, apt.id, JSON.stringify(payload), now.toISOString());
        audit(apt.tenant_id, apt.id, null, "late_payment_full_refund", { eventId });
        return payload;
      }
      const tenant = db.prepare("SELECT * FROM tenants WHERE id=?").get(apt.tenant_id);
      const approvalExpiresAt = new Date(now.getTime() + tenant.approval_minutes * 60_000).toISOString();
      db.prepare("UPDATE appointments SET status='pending_approval',approval_expires_at=?,updated_at=? WHERE id=? AND status='held'").run(approvalExpiresAt, now.toISOString(), apt.id);
      db.prepare("INSERT INTO payments(tenant_id,appointment_id,provider,provider_payment_ref,amount_kurus,status,created_at,updated_at) VALUES(?,?,?,?,?,'succeeded',?,?)")
        .run(apt.tenant_id, apt.id, "demo", `demo_pay_${apt.id}_${eventId}`, apt.charge_kurus, now.toISOString(), now.toISOString());
      const targetStaffIds = apt.selection_mode === "pool" ? JSON.parse(apt.eligible_staff_json) : [apt.staff_id];
      for (const staffId of targetStaffIds) {
        const staffUser = db.prepare("SELECT user_id FROM staff_profiles WHERE id=?").get(staffId);
        notify({ tenantId: apt.tenant_id, userId: staffUser?.user_id, appointmentId: apt.id, kind: "approval_required", title: "Ödemesi alınan randevu", body: `${apt.customer_name_snapshot} için kabul bekliyor.`, requiresAction: true, dedupeKey: `approval-${apt.id}-${staffId}` });
      }
      const payload = { status: "pending_approval", appointmentId: apt.id, approvalExpiresAt, message: "Demo ödeme başarılı; randevu çalışan onayı bekliyor." };
      db.prepare("INSERT INTO provider_events(provider,event_id,appointment_id,result_json,created_at) VALUES('demo',?,?,?,?)").run(eventId, apt.id, JSON.stringify(payload), now.toISOString());
      audit(apt.tenant_id, apt.id, null, "demo_payment_succeeded", { eventId, amountKurus: apt.charge_kurus });
      return payload;
    });
    return sendJson(res, 200, result);
  }

  if (method === "GET" && path === "/api/public/appointment") {
    const apt = appointmentDetailsByToken(url.searchParams.get("token"));
    const notifications = db.prepare("SELECT id,kind,title,body,read_at AS readAt,created_at AS createdAt FROM notifications WHERE appointment_id=? AND customer_id=? ORDER BY id DESC").all(apt.id, apt.customer_id);
    return sendJson(res, 200, { appointment: shapeAppointment(apt), notifications });
  }

  const publicCancel = path.match(/^\/api\/public\/appointments\/(\d+)\/cancel$/);
  if (method === "POST" && publicCancel) {
    const body = await readBody(req); const apt = appointmentDetailsByToken(body.manageToken);
    if (apt.id !== Number(publicCancel[1])) throw new AppError(404, "Randevu bulunamadı", "NOT_FOUND");
    if (!["pending_approval", "confirmed"].includes(apt.status)) throw new AppError(409, "Bu randevu iptal edilemez", "INVALID_STATE");
    const tenant = db.prepare("SELECT * FROM tenants WHERE id=?").get(apt.tenant_id);
    const outcome = cancellationOutcome({ now: new Date(), startAt: apt.start_at, cutoffHours: tenant.cancellation_hours, totalKurus: apt.charge_kurus, depositKurus: apt.deposit_kurus });
    withImmediateTransaction(db, () => {
      const nextStatus = outcome.kind === "no_show" ? "no_show" : "cancelled";
      db.prepare("UPDATE appointments SET status=?,cancellation_kind=?,cancellation_actor='customer',refund_kurus=?,retained_kurus=?,updated_at=? WHERE id=?")
        .run(nextStatus, outcome.kind, outcome.refundKurus, outcome.retainedKurus, new Date().toISOString(), apt.id);
      if (outcome.refundKurus) applyRefund(apt, outcome.refundKurus, outcome.refundKurus === apt.charge_kurus ? "fully_refunded" : "partially_refunded");
      const staffUser = db.prepare("SELECT user_id FROM staff_profiles WHERE id=COALESCE(?,?)").get(apt.staff_id, apt.capacity_staff_id);
      notify({ tenantId: apt.tenant_id, userId: staffUser?.user_id, appointmentId: apt.id, kind: "customer_cancelled", title: "Müşteri randevuyu iptal etti", body: outcome.kind === "late_cancel" ? "Kapora tutuldu, kalan tutar iade edildi." : "Tam iade uygulandı.", dedupeKey: `customer-cancel-${apt.id}` });
      audit(apt.tenant_id, apt.id, null, "customer_cancelled", outcome);
    });
    return sendJson(res, 200, { status: "cancelled", outcome });
  }

  const publicReview = path.match(/^\/api\/public\/appointments\/(\d+)\/review$/);
  if (method === "POST" && publicReview) {
    const body = await readBody(req); const apt = appointmentDetailsByToken(body.manageToken);
    if (apt.id !== Number(publicReview[1])) throw new AppError(404, "Randevu bulunamadı", "NOT_FOUND");
    if (apt.status !== "completed") throw new AppError(409, "Yalnız tamamlanan hizmete yorum bırakılabilir", "NOT_COMPLETED");
    const stars = Number(body.stars); const comment = String(body.comment || "").trim();
    if (!Number.isInteger(stars) || stars < 1 || stars > 5 || comment.length < 2 || comment.length > 1000) throw new AppError(400, "1–5 yıldız ve kısa bir yorum girin", "REVIEW_INVALID");
    try { db.prepare("INSERT INTO reviews(tenant_id,appointment_id,customer_id,stars,comment,created_at) VALUES(?,?,?,?,?,?)").run(apt.tenant_id, apt.id, apt.customer_id, stars, comment, new Date().toISOString()); }
    catch { throw new AppError(409, "Bu randevu için yorum zaten var", "REVIEW_EXISTS"); }
    audit(apt.tenant_id, apt.id, null, "review_created", { stars });
    return sendJson(res, 201, { ok: true, visibility: "business_owner_only" });
  }

  if (method === "POST" && path === "/api/auth/login") {
    const body = await readBody(req); const username = String(body.username || "").trim(); const tenantSlug = String(body.tenantSlug || "yakupberber");
    let user;
    if (body.role === "platform_owner") user = db.prepare("SELECT * FROM users WHERE tenant_id IS NULL AND username=?").get(username);
    else {
      const tenant = getTenantBySlug(tenantSlug);
      if (tenant) user = db.prepare("SELECT * FROM users WHERE tenant_id=? AND username=?").get(tenant.id, username);
    }
    if (!user || !user.active || !verifyPassword(body.password, user.password_hash)) throw new AppError(401, "Kullanıcı adı veya şifre hatalı", "LOGIN_FAILED");
    const token = newToken(); const now = new Date();
    db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now.toISOString());
    db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(tokenHash(token), user.id, new Date(now.getTime() + 8 * 3_600_000).toISOString(), now.toISOString());
    audit(user.tenant_id, null, user.id, "login", { role: user.role });
    return sendJson(res, 200, { user: { id: user.id, role: user.role, displayName: user.display_name, mustChangePassword: Boolean(user.must_change_password) } }, { "Set-Cookie": sessionCookie(token) });
  }

  if (method === "POST" && path === "/api/auth/logout") {
    const token = parseCookies(req.headers.cookie).er_session;
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(token));
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }

  if (method === "GET" && path === "/api/auth/me") {
    const user = authenticate(req);
    return sendJson(res, 200, { user: user ? { id: user.id, tenantId: user.tenant_id, role: user.role, username: user.username, displayName: user.display_name, mustChangePassword: Boolean(user.must_change_password) } : null });
  }

  if (method === "POST" && path === "/api/auth/change-password") {
    const user = requireUser(req); const body = await readBody(req);
    if (!verifyPassword(body.currentPassword, user.password_hash)) throw new AppError(400, "Mevcut şifre yanlış", "PASSWORD_INVALID");
    db.prepare("UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?").run(hashPassword(body.newPassword), user.id);
    audit(user.tenant_id, null, user.id, "password_changed");
    return sendJson(res, 200, { ok: true });
  }

  if (method === "GET" && path === "/api/staff/dashboard") {
    const user = requireUser(req, ["staff"]); const staff = staffForUser(user);
    const rows = db.prepare(`SELECT a.*,c.no_show_score,sp.name AS staff_name FROM appointments a JOIN customers c ON c.id=a.customer_id
      LEFT JOIN staff_profiles sp ON sp.id=a.staff_id WHERE a.tenant_id=? AND a.status<>'expired' ORDER BY a.start_at`).all(user.tenant_id)
      .filter((row) => row.staff_id === staff.id || (row.selection_mode === "pool" && JSON.parse(row.eligible_staff_json).includes(staff.id)));
    const notifications = db.prepare("SELECT * FROM notifications WHERE tenant_id=? AND user_id=? ORDER BY created_at DESC LIMIT 50").all(user.tenant_id, user.id);
    return sendJson(res, 200, { user: { displayName: user.display_name, mustChangePassword: Boolean(user.must_change_password) }, staff: { id: staff.id, name: staff.name, color: staff.color }, appointments: rows.map(shapeAppointment), notifications });
  }

  const staffAccept = path.match(/^\/api\/staff\/appointments\/(\d+)\/accept$/);
  if (method === "POST" && staffAccept) {
    const user = requireUser(req, ["staff"]); const staff = staffForUser(user); const appointmentId = Number(staffAccept[1]);
    const result = withImmediateTransaction(db, () => {
      const apt = db.prepare("SELECT * FROM appointments WHERE id=? AND tenant_id=?").get(appointmentId, user.tenant_id);
      if (!apt) throw new AppError(404, "Randevu bulunamadı", "NOT_FOUND");
      if (apt.status !== "pending_approval") throw new AppError(409, "Randevu artık kabul beklemiyor", "ALREADY_CLAIMED");
      const eligible = JSON.parse(apt.eligible_staff_json);
      if (!eligible.includes(staff.id) || (apt.selection_mode === "direct" && apt.staff_id !== staff.id)) throw new AppError(403, "Bu randevuyu kabul edemezsiniz", "NOT_ELIGIBLE");
      if (staffHasConflict(apt.tenant_id, staff.id, apt.start_at, apt.end_at, apt.id)) throw new AppError(409, "Takviminiz bu aralıkta dolu", "STAFF_CONFLICT");
      const now = new Date().toISOString();
      const changed = db.prepare("UPDATE appointments SET status='confirmed',staff_id=?,capacity_staff_id=?,updated_at=? WHERE id=? AND status='pending_approval'").run(staff.id, staff.id, now, apt.id);
      if (!changed.changes) throw new AppError(409, "Başka bir çalışan önce kabul etti", "ALREADY_CLAIMED");
      notify({ tenantId: apt.tenant_id, customerId: apt.customer_id, appointmentId: apt.id, kind: "booking_confirmed", title: "Randevunuz onaylandı", body: `${staff.name} randevunuzu onayladı.`, dedupeKey: `confirmed-customer-${apt.id}` });
      audit(apt.tenant_id, apt.id, user.id, "staff_accepted", { staffId: staff.id });
      return { status: "confirmed", staffName: staff.name };
    });
    return sendJson(res, 200, result);
  }

  const attendanceRoute = path.match(/^\/api\/(staff|admin)\/appointments\/(\d+)\/attendance$/);
  if (method === "POST" && attendanceRoute) {
    const role = attendanceRoute[1] === "staff" ? "staff" : "business_admin";
    const user = requireUser(req, [role]); const body = await readBody(req); const action = String(body.action);
    if (!["arrived", "no_show", "completed"].includes(action)) throw new AppError(400, "Geçersiz devam durumu", "ATTENDANCE_INVALID");
    const apt = db.prepare("SELECT * FROM appointments WHERE id=? AND tenant_id=?").get(Number(attendanceRoute[2]), user.tenant_id);
    if (!apt) throw new AppError(404, "Randevu bulunamadı", "NOT_FOUND");
    if (role === "staff") {
      const staff = staffForUser(user);
      if (apt.staff_id !== staff.id) throw new AppError(403, "Yalnız kendi randevunuzu güncelleyebilirsiniz", "FORBIDDEN");
    }
    const old = apt.attendance_status; let scoreApplied = apt.attendance_score_applied;
    withImmediateTransaction(db, () => {
      if (action === "arrived" || action === "completed") {
        if (scoreApplied) { db.prepare("UPDATE customers SET no_show_score=MAX(0,no_show_score-1) WHERE id=?").run(apt.customer_id); scoreApplied = 0; }
      } else if (!scoreApplied) { db.prepare("UPDATE customers SET no_show_score=no_show_score+1 WHERE id=?").run(apt.customer_id); scoreApplied = 1; }
      const nextAttendance = action === "completed" ? "arrived" : action;
      const nextStatus = action === "completed" ? "completed" : action === "no_show" ? "no_show" : (apt.status === "no_show" ? "confirmed" : apt.status);
      db.prepare("UPDATE appointments SET attendance_status=?,attendance_score_applied=?,status=?,retained_kurus=CASE WHEN ?='no_show' THEN charge_kurus ELSE retained_kurus END,updated_at=? WHERE id=?")
        .run(nextAttendance, scoreApplied, nextStatus, action, new Date().toISOString(), apt.id);
      db.prepare("UPDATE notifications SET resolved_at=? WHERE appointment_id=? AND kind='attendance_unresolved'").run(new Date().toISOString(), apt.id);
      audit(apt.tenant_id, apt.id, user.id, role === "business_admin" && old !== nextAttendance ? "attendance_owner_correction" : "attendance_decided", { from: old, to: nextAttendance, scoreApplied });
    });
    return sendJson(res, 200, { ok: true, attendance: action, corrected: old !== action });
  }

  if (method === "GET" && path === "/api/admin/dashboard") {
    const user = requireUser(req, ["business_admin"]); const tenant = db.prepare("SELECT * FROM tenants WHERE id=?").get(user.tenant_id);
    const appointments = db.prepare(`SELECT a.*,sp.name AS staff_name,c.no_show_score FROM appointments a
      LEFT JOIN staff_profiles sp ON sp.id=a.staff_id JOIN customers c ON c.id=a.customer_id WHERE a.tenant_id=? AND a.status<>'expired' ORDER BY a.start_at DESC LIMIT 100`).all(user.tenant_id).map(shapeAppointment);
    const staff = db.prepare(`SELECT sp.id,sp.name,sp.color,sp.active,u.username,u.active AS account_active,
      COUNT(DISTINCT CASE WHEN a.status IN ('confirmed','completed','no_show') THEN a.customer_id END) AS customer_count
      FROM staff_profiles sp JOIN users u ON u.id=sp.user_id LEFT JOIN appointments a ON a.staff_id=sp.id
      WHERE sp.tenant_id=? GROUP BY sp.id ORDER BY sp.id`).all(user.tenant_id);
    const services = db.prepare("SELECT id,name,price_kurus AS priceKurus,duration_min AS durationMin,active FROM services WHERE tenant_id=? ORDER BY active DESC,id").all(user.tenant_id);
    const customers = db.prepare("SELECT id,full_name AS fullName,phone,no_show_score AS noShowScore,created_at AS createdAt FROM customers WHERE tenant_id=? ORDER BY created_at DESC").all(user.tenant_id);
    const revenue = db.prepare(`SELECT COALESCE(SUM(p.amount_kurus),0) AS grossKurus,COALESCE(SUM(p.refund_kurus),0) AS refundKurus,
      COALESCE(SUM(p.amount_kurus-p.refund_kurus),0) AS netKurus,COUNT(*) AS paidCount FROM payments p WHERE p.tenant_id=?`).get(user.tenant_id);
    const reviews = db.prepare(`SELECT r.id,r.stars,r.comment,r.created_at AS createdAt,a.customer_name_snapshot AS customerName
      FROM reviews r JOIN appointments a ON a.id=r.appointment_id WHERE r.tenant_id=? ORDER BY r.id DESC`).all(user.tenant_id);
    const notifications = db.prepare("SELECT * FROM notifications WHERE tenant_id=? ORDER BY created_at DESC LIMIT 80").all(user.tenant_id);
    const auditRows = db.prepare("SELECT id,appointment_id AS appointmentId,event_type AS eventType,detail_json AS detail,created_at AS createdAt FROM audit_events WHERE tenant_id=? ORDER BY id DESC LIMIT 40").all(user.tenant_id);
    return sendJson(res, 200, { tenant: publicTenant(tenant), subscriptionEndsAt: tenant.subscription_ends_at, appointments, staff, services, customers, revenue, reviews, notifications, audit: auditRows });
  }

  if (method === "POST" && path === "/api/admin/settings") {
    const user = requireUser(req, ["business_admin"]); const body = await readBody(req);
    const values = {
      appName: String(body.appName || "").trim(), logoText: String(body.logoText || "").trim().slice(0, 4),
      primaryColor: String(body.primaryColor || ""), accentColor: String(body.accentColor || ""),
      bufferMinutes: Number(body.bufferMinutes), depositRate: Number(body.depositRate), cancellationHours: Number(body.cancellationHours),
      approvalMinutes: Number(body.approvalMinutes), graceMinutes: Number(body.graceMinutes),
    };
    if (!values.appName || !/^#[0-9a-f]{6}$/i.test(values.primaryColor) || !/^#[0-9a-f]{6}$/i.test(values.accentColor)
      || values.bufferMinutes < 5 || values.bufferMinutes > 10 || values.depositRate < 0 || values.depositRate > 100
      || values.cancellationHours < 1 || values.approvalMinutes < 5 || values.graceMinutes < 0) throw new AppError(400, "Ayar değerlerini kontrol edin", "SETTINGS_INVALID");
    db.prepare(`UPDATE tenants SET app_name=?,logo_text=?,primary_color=?,accent_color=?,buffer_minutes=?,deposit_rate=?,cancellation_hours=?,approval_minutes=?,grace_minutes=? WHERE id=?`)
      .run(values.appName, values.logoText || "ER", values.primaryColor, values.accentColor, values.bufferMinutes, values.depositRate, values.cancellationHours, values.approvalMinutes, values.graceMinutes, user.tenant_id);
    audit(user.tenant_id, null, user.id, "settings_updated", values);
    return sendJson(res, 200, { ok: true });
  }

  if (method === "POST" && path === "/api/admin/branding/logo") {
    const user = requireUser(req, ["business_admin"]); const body = await readBody(req); const dataUrl = String(body.dataUrl || "");
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) throw new AppError(415, "PNG, JPEG veya WebP logo seçin", "LOGO_TYPE_INVALID");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > 180_000) throw new AppError(413, "Logo en fazla 180 KB olabilir", "LOGO_TOO_LARGE");
    db.prepare("UPDATE tenants SET logo_data_url=? WHERE id=?").run(dataUrl, user.tenant_id);
    audit(user.tenant_id, null, user.id, "logo_uploaded", { mime: match[1], bytes: bytes.length });
    const tenant = db.prepare("SELECT slug FROM tenants WHERE id=?").get(user.tenant_id);
    return sendJson(res, 200, { ok: true, logoUrl: `/api/public/logo?isletme=${encodeURIComponent(tenant.slug)}` });
  }

  if (method === "POST" && path === "/api/admin/services") {
    const user = requireUser(req, ["business_admin"]); const body = await readBody(req); const name = String(body.name || "").trim();
    const priceKurus = Math.round(Number(body.priceTl) * 100); const duration = Number(body.durationMin);
    if (!name || !Number.isInteger(priceKurus) || priceKurus < 0 || !Number.isInteger(duration) || duration < 5) throw new AppError(400, "Hizmet bilgileri geçersiz", "SERVICE_INVALID");
    const id = Number(db.prepare("INSERT INTO services(tenant_id,name,price_kurus,duration_min,created_at) VALUES(?,?,?,?,?)").run(user.tenant_id, name, priceKurus, duration, new Date().toISOString()).lastInsertRowid);
    audit(user.tenant_id, null, user.id, "service_created", { id, name, priceKurus, duration });
    return sendJson(res, 201, { id, name, priceKurus, durationMin: duration });
  }

  const serviceToggle = path.match(/^\/api\/admin\/services\/(\d+)\/toggle$/);
  if (method === "POST" && serviceToggle) {
    const user = requireUser(req, ["business_admin"]); const row = db.prepare("SELECT * FROM services WHERE id=? AND tenant_id=?").get(Number(serviceToggle[1]), user.tenant_id);
    if (!row) throw new AppError(404, "Hizmet bulunamadı", "NOT_FOUND");
    db.prepare("UPDATE services SET active=? WHERE id=?").run(row.active ? 0 : 1, row.id);
    audit(user.tenant_id, null, user.id, "service_toggled", { id: row.id, active: !row.active });
    return sendJson(res, 200, { ok: true, active: !row.active });
  }

  if (method === "POST" && path === "/api/admin/staff") {
    const user = requireUser(req, ["business_admin"]); const body = await readBody(req);
    const name = String(body.name || "").trim(); const username = String(body.username || "").trim().toLowerCase(); const serviceIds = (body.serviceIds || []).map(Number);
    if (!name || !/^[a-z0-9._-]{3,30}$/.test(username) || !serviceIds.length) throw new AppError(400, "Personel bilgilerini kontrol edin", "STAFF_INVALID");
    const schedule = JSON.stringify({ 0: [["10:00", "17:00"]], 1: [["09:00", "20:00"]], 2: [["09:00", "20:00"]], 3: [["09:00", "20:00"]], 4: [["09:00", "20:00"]], 5: [["09:00", "20:00"]], 6: [["09:00", "20:00"]] });
    const result = withImmediateTransaction(db, () => {
      let userId;
      try { userId = Number(db.prepare("INSERT INTO users(tenant_id,role,username,password_hash,display_name,must_change_password,created_at) VALUES(?,'staff',?,?,?,?,?)")
        .run(user.tenant_id, username, hashPassword(body.initialPassword), name, 1, new Date().toISOString()).lastInsertRowid); }
      catch (error) { if (String(error).includes("UNIQUE")) throw new AppError(409, "Bu kullanıcı adı kullanılıyor", "USERNAME_EXISTS"); throw error; }
      const staffId = Number(db.prepare("INSERT INTO staff_profiles(tenant_id,user_id,name,color,weekly_hours_json,created_at) VALUES(?,?,?,?,?,?)")
        .run(user.tenant_id, userId, name, String(body.color || "#2f7c72"), schedule, new Date().toISOString()).lastInsertRowid);
      const link = db.prepare("INSERT INTO staff_services(staff_id,service_id) SELECT ?,id FROM services WHERE id=? AND tenant_id=?");
      for (const serviceId of serviceIds) link.run(staffId, serviceId, user.tenant_id);
      return { staffId, userId };
    });
    audit(user.tenant_id, null, user.id, "staff_created", { ...result, username });
    return sendJson(res, 201, result);
  }

  const staffToggle = path.match(/^\/api\/admin\/staff\/(\d+)\/toggle$/);
  if (method === "POST" && staffToggle) {
    const user = requireUser(req, ["business_admin"]); const staff = db.prepare("SELECT * FROM staff_profiles WHERE id=? AND tenant_id=?").get(Number(staffToggle[1]), user.tenant_id);
    if (!staff) throw new AppError(404, "Personel bulunamadı", "NOT_FOUND");
    const next = staff.active ? 0 : 1;
    db.prepare("UPDATE staff_profiles SET active=? WHERE id=?").run(next, staff.id); db.prepare("UPDATE users SET active=? WHERE id=?").run(next, staff.user_id);
    audit(user.tenant_id, null, user.id, next ? "staff_reactivated" : "staff_deactivated", { staffId: staff.id });
    return sendJson(res, 200, { ok: true, active: Boolean(next), historyPreserved: true });
  }

  const adminCancel = path.match(/^\/api\/admin\/appointments\/(\d+)\/cancel$/);
  if (method === "POST" && adminCancel) {
    const user = requireUser(req, ["business_admin"]); const apt = db.prepare("SELECT * FROM appointments WHERE id=? AND tenant_id=?").get(Number(adminCancel[1]), user.tenant_id);
    if (!apt) throw new AppError(404, "Randevu bulunamadı", "NOT_FOUND");
    if (!["pending_approval", "confirmed"].includes(apt.status)) throw new AppError(409, "Randevu bu durumda iptal edilemez", "INVALID_STATE");
    withImmediateTransaction(db, () => {
      db.prepare("UPDATE appointments SET status='cancelled',cancellation_kind='business_cancel',cancellation_actor='business',refund_kurus=charge_kurus,retained_kurus=0,updated_at=? WHERE id=?").run(new Date().toISOString(), apt.id);
      applyRefund(apt, apt.charge_kurus, "fully_refunded");
      notify({ tenantId: apt.tenant_id, customerId: apt.customer_id, appointmentId: apt.id, kind: "business_cancelled", title: "İşletme randevuyu iptal etti", body: "Tam iade iş akışı uygulandı.", dedupeKey: `business-cancel-${apt.id}` });
      audit(apt.tenant_id, apt.id, user.id, "business_cancelled_full_refund", { refundKurus: apt.charge_kurus });
    });
    return sendJson(res, 200, { ok: true, refundKurus: apt.charge_kurus });
  }

  const notificationRead = path.match(/^\/api\/notifications\/(\d+)\/read$/);
  if (method === "POST" && notificationRead) {
    const user = requireUser(req, ["staff", "business_admin"]); const item = db.prepare("SELECT * FROM notifications WHERE id=? AND tenant_id=?").get(Number(notificationRead[1]), user.tenant_id);
    if (!item || (user.role === "staff" && item.user_id !== user.id)) throw new AppError(404, "Bildirim bulunamadı", "NOT_FOUND");
    db.prepare("UPDATE notifications SET read_at=? WHERE id=?").run(new Date().toISOString(), item.id);
    return sendJson(res, 200, { ok: true, resolved: Boolean(item.resolved_at), requiresAction: Boolean(item.requires_action), note: item.requires_action && !item.resolved_at ? "Okundu; fakat işlem görevi çözülene kadar açık kalır." : undefined });
  }

  if (method === "GET" && path === "/api/platform/dashboard") {
    const user = requireUser(req, ["platform_owner"]);
    const tenants = db.prepare(`SELECT id,slug,name,app_name AS appName,subscription_status AS subscriptionStatus,subscription_ends_at AS subscriptionEndsAt,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id AND u.role='staff' AND u.active=1) AS activeStaffCount
      FROM tenants t ORDER BY t.id`).all();
    return sendJson(res, 200, { user: { displayName: user.display_name }, tenants, privacyBoundary: "Müşteri bilgileri, yorumlar ve işletme gelir ayrıntıları platform görünümüne dahil edilmez.", system: { status: "healthy", database: "SQLite/WAL demo", payment: "demo adapter", sms: "demo", webPush: "production keys required" } });
  }

  if (method === "POST" && path === "/api/platform/tenants") {
    const user = requireUser(req, ["platform_owner"]); const body = await readBody(req); const slug = String(body.slug || "").trim().toLowerCase(); const name = String(body.name || "").trim();
    if (!/^[a-z0-9-]{3,40}$/.test(slug) || !name) throw new AppError(400, "İşletme adı ve alt alan adı geçersiz", "TENANT_INVALID");
    const ends = body.subscriptionEndsAt && Number.isFinite(new Date(body.subscriptionEndsAt).getTime()) ? new Date(body.subscriptionEndsAt).toISOString() : new Date(Date.now() + 30 * 86_400_000).toISOString();
    const result = withImmediateTransaction(db, () => {
      let tenantId;
      try { tenantId = Number(db.prepare("INSERT INTO tenants(slug,name,app_name,subscription_ends_at,created_at) VALUES(?,?,?,?,?)").run(slug, name, "E-Randevum", ends, new Date().toISOString()).lastInsertRowid); }
      catch { throw new AppError(409, "Bu alt alan adı kullanılıyor", "SLUG_EXISTS"); }
      const adminId = Number(db.prepare("INSERT INTO users(tenant_id,role,username,password_hash,display_name,must_change_password,created_at) VALUES(?,'business_admin',?,?,?,?,?)")
        .run(tenantId, String(body.adminUsername || "yonetici"), hashPassword(body.initialPassword), String(body.adminName || "İşletme Yöneticisi"), 1, new Date().toISOString()).lastInsertRowid);
      return { tenantId, adminId };
    });
    audit(null, null, user.id, "tenant_created", { ...result, slug });
    return sendJson(res, 201, result);
  }

  const subscriptionRoute = path.match(/^\/api\/platform\/tenants\/(\d+)\/subscription$/);
  if (method === "POST" && subscriptionRoute) {
    const user = requireUser(req, ["platform_owner"]); const body = await readBody(req); const status = String(body.status);
    if (!['active','expired','suspended'].includes(status) || !Number.isFinite(new Date(body.endsAt).getTime())) throw new AppError(400, "Abonelik bilgileri geçersiz", "SUBSCRIPTION_INVALID");
    const result = db.prepare("UPDATE tenants SET subscription_status=?,subscription_ends_at=? WHERE id=?").run(status, new Date(body.endsAt).toISOString(), Number(subscriptionRoute[1]));
    if (!result.changes) throw new AppError(404, "İşletme bulunamadı", "NOT_FOUND");
    audit(null, null, user.id, "subscription_updated", { tenantId: Number(subscriptionRoute[1]), status, endsAt: body.endsAt, paidExternally: true });
    return sendJson(res, 200, { ok: true, paidExternally: true, platformCommission: 0 });
  }

  throw new AppError(404, "API adresi bulunamadı", "NOT_FOUND");
}

function serveManifest(req, res, url) {
  const tenant = resolveTenant(req, url);
  return sendJson(res, 200, {
    id: `/${tenant.slug}`, name: `${tenant.app_name} · ${tenant.name}`, short_name: tenant.app_name,
    description: `${tenant.name} için randevu uygulaması`, start_url: `/randevu?isletme=${tenant.slug}`, scope: "/",
    display: "standalone", background_color: "#f4f7f6", theme_color: tenant.primary_color,
    icons: [{ src: `/favicon.svg?isletme=${tenant.slug}`, sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
  });
}

function serveFavicon(req, res, url) {
  const tenant = resolveTenant(req, url); const safe = tenant.favicon_text.replace(/[^A-Za-z0-9ÇĞİÖŞÜçğıöşü]/g, "").slice(0, 2) || "ER";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${tenant.primary_color}"/><path d="M16 45V19h32v7H24v4h19v7H24v8z" fill="${tenant.accent_color}"/><text x="32" y="56" text-anchor="middle" font-family="Arial" font-size="9" font-weight="700" fill="white">${safe}</text></svg>`;
  res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public,max-age=3600" }); res.end(svg);
}

function serveStatic(res, pathname) {
  const requested = pathname === "/" || ["/randevu", "/personel", "/yonetici", "/platform", "/giris", "/odeme"].includes(pathname) ? "index.html" : pathname.replace(/^\//, "");
  const target = resolve(PUBLIC_DIR, normalize(requested));
  if (!target.startsWith(resolve(PUBLIC_DIR)) || !existsSync(target)) return false;
  const data = readFileSync(target); const headers = { "Content-Type": mime[extname(target)] || "application/octet-stream" };
  if (requested === "sw.js") headers["Service-Worker-Allowed"] = "/";
  headers["Cache-Control"] = requested === "index.html" ? "no-store" : "public,max-age=300";
  res.writeHead(200, headers); res.end(data); return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (url.pathname === "/manifest.webmanifest") return serveManifest(req, res, url);
    if (url.pathname === "/favicon.svg") return serveFavicon(req, res, url);
    if (serveStatic(res, url.pathname)) return;
    throw new AppError(404, "Sayfa bulunamadı", "NOT_FOUND");
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    if (status === 500) console.error(error);
    sendJson(res, status, { error: { code: error.code || "INTERNAL_ERROR", message: status === 500 ? "Beklenmeyen bir hata oluştu" : error.message, detail: error.detail } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`E-Randevum hazır: http://${HOST}:${PORT}/randevu?isletme=yakupberber`);
  console.log(`Veri: ${DATA_FILE}`);
});

const maintenanceTimer = setInterval(() => { try { expireAndSchedule(); } catch (error) { console.error("Bakım görevi:", error); } }, 60_000);
maintenanceTimer.unref();

function shutdown() { clearInterval(maintenanceTimer); try { db.close(); } catch {} server.close(() => process.exit(0)); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);

export { server, db, expireAndSchedule };
