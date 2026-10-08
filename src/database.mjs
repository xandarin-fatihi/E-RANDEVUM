import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { hashPassword, newToken, tokenHash } from "./security.mjs";
import { calculateReservation } from "./domain.mjs";

export const SCHEMA_VERSION = 1;

export function createDatabase(filePath, { reset = false, seed = true } = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  if (reset) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${filePath}${suffix}`, { force: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  migrate(db);
  if (seed) seedDemo(db);
  db.exec("PRAGMA optimize;");
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      app_name TEXT NOT NULL DEFAULT 'E-Randevum',
      logo_text TEXT NOT NULL DEFAULT 'ER',
      logo_data_url TEXT,
      favicon_text TEXT NOT NULL DEFAULT 'ER',
      primary_color TEXT NOT NULL DEFAULT '#173f3a',
      accent_color TEXT NOT NULL DEFAULT '#e7a94b',
      timezone TEXT NOT NULL DEFAULT 'Europe/Istanbul',
      buffer_minutes INTEGER NOT NULL DEFAULT 10 CHECK(buffer_minutes BETWEEN 5 AND 10),
      deposit_rate INTEGER NOT NULL DEFAULT 30 CHECK(deposit_rate BETWEEN 0 AND 100),
      cancellation_hours INTEGER NOT NULL DEFAULT 3 CHECK(cancellation_hours BETWEEN 1 AND 72),
      approval_minutes INTEGER NOT NULL DEFAULT 30 CHECK(approval_minutes BETWEEN 5 AND 240),
      grace_minutes INTEGER NOT NULL DEFAULT 5 CHECK(grace_minutes BETWEEN 0 AND 60),
      subscription_status TEXT NOT NULL DEFAULT 'active' CHECK(subscription_status IN ('active','expired','suspended')),
      subscription_ends_at TEXT NOT NULL,
      phone_mode TEXT NOT NULL DEFAULT 'demo',
      payment_mode TEXT NOT NULL DEFAULT 'demo',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id),
      role TEXT NOT NULL CHECK(role IN ('platform_owner','business_admin','staff')),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(tenant_id, username)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_username ON users(username) WHERE tenant_id IS NULL;

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS staff_profiles (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      weekly_hours_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_staff_tenant ON staff_profiles(tenant_id, active);

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL,
      price_kurus INTEGER NOT NULL CHECK(price_kurus >= 0),
      duration_min INTEGER NOT NULL CHECK(duration_min BETWEEN 5 AND 480),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_services_tenant ON services(tenant_id, active);

    CREATE TABLE IF NOT EXISTS staff_services (
      staff_id INTEGER NOT NULL REFERENCES staff_profiles(id),
      service_id INTEGER NOT NULL REFERENCES services(id),
      PRIMARY KEY(staff_id, service_id)
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      phone_verified INTEGER NOT NULL DEFAULT 0,
      phone_verification_mode TEXT NOT NULL DEFAULT 'demo',
      no_show_score INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(tenant_id, phone)
    );
    CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id, created_at);

    CREATE TABLE IF NOT EXISTS phone_verifications (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      phone TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      token_hash TEXT,
      verified_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_phone_verify ON phone_verifications(tenant_id, phone, expires_at);

    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      staff_id INTEGER REFERENCES staff_profiles(id),
      capacity_staff_id INTEGER NOT NULL REFERENCES staff_profiles(id),
      eligible_staff_json TEXT NOT NULL,
      selection_mode TEXT NOT NULL CHECK(selection_mode IN ('direct','pool')),
      status TEXT NOT NULL CHECK(status IN ('held','expired','pending_approval','confirmed','completed','cancelled','no_show')),
      start_at TEXT NOT NULL,
      service_end_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      total_service_minutes INTEGER NOT NULL,
      buffer_minutes INTEGER NOT NULL,
      reserved_minutes INTEGER NOT NULL,
      charge_kurus INTEGER NOT NULL,
      deposit_kurus INTEGER NOT NULL,
      refund_kurus INTEGER NOT NULL DEFAULT 0,
      retained_kurus INTEGER NOT NULL DEFAULT 0,
      hold_token_hash TEXT NOT NULL UNIQUE,
      manage_token_hash TEXT NOT NULL UNIQUE,
      hold_expires_at TEXT NOT NULL,
      approval_expires_at TEXT,
      cancel_cutoff_at TEXT NOT NULL,
      cancellation_kind TEXT,
      cancellation_actor TEXT,
      attendance_status TEXT NOT NULL DEFAULT 'pending' CHECK(attendance_status IN ('pending','auto_no_show','arrived','no_show')),
      attendance_score_applied INTEGER NOT NULL DEFAULT 0,
      customer_name_snapshot TEXT NOT NULL,
      customer_phone_snapshot TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_appointments_tenant_time ON appointments(tenant_id, start_at, end_at);
    CREATE INDEX IF NOT EXISTS idx_appointments_capacity ON appointments(tenant_id, capacity_staff_id, start_at, end_at, status);
    CREATE INDEX IF NOT EXISTS idx_appointments_staff ON appointments(tenant_id, staff_id, start_at);

    CREATE TABLE IF NOT EXISTS appointment_services (
      appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      service_id INTEGER REFERENCES services(id),
      name_snapshot TEXT NOT NULL,
      price_kurus_snapshot INTEGER NOT NULL,
      duration_min_snapshot INTEGER NOT NULL,
      PRIMARY KEY(appointment_id, name_snapshot)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id),
      provider TEXT NOT NULL,
      provider_payment_ref TEXT NOT NULL UNIQUE,
      amount_kurus INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('succeeded','refund_pending','partially_refunded','fully_refunded')),
      refund_kurus INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_events (
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      appointment_id INTEGER REFERENCES appointments(id),
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(provider, event_id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      user_id INTEGER REFERENCES users(id),
      customer_id INTEGER REFERENCES customers(id),
      appointment_id INTEGER REFERENCES appointments(id),
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'in_app',
      push_status TEXT NOT NULL DEFAULT 'not_configured',
      requires_action INTEGER NOT NULL DEFAULT 0,
      read_at TEXT,
      resolved_at TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(tenant_id, user_id, created_at);

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id),
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
      comment TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id),
      appointment_id INTEGER REFERENCES appointments(id),
      actor_user_id INTEGER REFERENCES users(id),
      event_type TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_events(tenant_id, created_at);
  `);
  const tenantColumns = new Set(db.prepare("PRAGMA table_info(tenants)").all().map((column) => column.name));
  if (!tenantColumns.has("logo_data_url")) db.exec("ALTER TABLE tenants ADD COLUMN logo_data_url TEXT;");
  db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(SCHEMA_VERSION));
}

function trDayIso(dayOffset, hour, minute = 0) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" });
  const today = formatter.format(new Date());
  const midnight = new Date(`${today}T00:00:00+03:00`);
  return new Date(midnight.getTime() + dayOffset * 86_400_000 + hour * 3_600_000 + minute * 60_000).toISOString();
}

function seedDemo(db) {
  if (db.prepare("SELECT 1 FROM tenants WHERE slug='yakupberber'").get()) return;
  const now = new Date().toISOString();
  const nextYear = new Date(Date.now() + 366 * 86_400_000).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const tenantId = Number(db.prepare(`
      INSERT INTO tenants(slug,name,app_name,logo_text,favicon_text,primary_color,accent_color,subscription_ends_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)
    `).run("yakupberber", "Yakup Berber & Bakım", "E-Randevum", "YB", "ER", "#143f3a", "#e8a948", nextYear, now).lastInsertRowid);

    const insertUser = db.prepare("INSERT INTO users(tenant_id,role,username,password_hash,display_name,must_change_password,created_at) VALUES(?,?,?,?,?,?,?)");
    const adminUserId = Number(insertUser.run(tenantId, "business_admin", "yonetici", hashPassword("Demo123!"), "Yakup Kaya", 0, now).lastInsertRowid);
    const platformUserId = Number(insertUser.run(null, "platform_owner", "platform", hashPassword("Platform123!"), "Platform Sahibi", 0, now).lastInsertRowid);
    void adminUserId; void platformUserId;

    const schedule = JSON.stringify({ 0: [["10:00", "17:00"]], 1: [["09:00", "20:00"]], 2: [["09:00", "20:00"]], 3: [["09:00", "20:00"]], 4: [["09:00", "20:00"]], 5: [["09:00", "20:00"]], 6: [["09:00", "20:00"]] });
    const staffRows = [
      ["ahmet", "Ahmet Usta", "#2f7c72"],
      ["elif", "Elif Uzman", "#c56f46"],
      ["derya", "Derya Bakım", "#745a91"],
    ];
    const staffIds = [];
    for (const [username, name, color] of staffRows) {
      const userId = Number(insertUser.run(tenantId, "staff", username, hashPassword("Usta123!"), name, 1, now).lastInsertRowid);
      staffIds.push(Number(db.prepare("INSERT INTO staff_profiles(tenant_id,user_id,name,color,weekly_hours_json,created_at) VALUES(?,?,?,?,?,?)").run(tenantId, userId, name, color, schedule, now).lastInsertRowid));
    }

    const insertService = db.prepare("INSERT INTO services(tenant_id,name,price_kurus,duration_min,created_at) VALUES(?,?,?,?,?)");
    const services = [
      { id: Number(insertService.run(tenantId, "Saç Kesimi", 30000, 30, now).lastInsertRowid), name: "Saç Kesimi", price_kurus: 30000, duration_min: 30 },
      { id: Number(insertService.run(tenantId, "Sakal Tasarımı", 18000, 20, now).lastInsertRowid), name: "Sakal Tasarımı", price_kurus: 18000, duration_min: 20 },
      { id: Number(insertService.run(tenantId, "Manikür", 42000, 45, now).lastInsertRowid), name: "Manikür", price_kurus: 42000, duration_min: 45 },
      { id: Number(insertService.run(tenantId, "Pedikür", 52000, 60, now).lastInsertRowid), name: "Pedikür", price_kurus: 52000, duration_min: 60 },
    ];
    const link = db.prepare("INSERT INTO staff_services(staff_id,service_id) VALUES(?,?)");
    for (const service of services.slice(0, 2)) link.run(staffIds[0], service.id);
    for (const service of services) link.run(staffIds[1], service.id);
    for (const service of services.slice(2)) link.run(staffIds[2], service.id);

    const customerId = Number(db.prepare("INSERT INTO customers(tenant_id,full_name,phone,phone_verified,phone_verification_mode,no_show_score,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(tenantId, "Selin Yılmaz", "+905551112233", 1, "demo", 1, now).lastInsertRowid);
    const customer2Id = Number(db.prepare("INSERT INTO customers(tenant_id,full_name,phone,phone_verified,phone_verification_mode,created_at) VALUES(?,?,?,?,?,?)")
      .run(tenantId, "Mert Demir", "+905552224455", 1, "demo", now).lastInsertRowid);

    const insertAppointment = db.prepare(`
      INSERT INTO appointments(tenant_id,customer_id,staff_id,capacity_staff_id,eligible_staff_json,selection_mode,status,start_at,service_end_at,end_at,
        total_service_minutes,buffer_minutes,reserved_minutes,charge_kurus,deposit_kurus,refund_kurus,retained_kurus,hold_token_hash,manage_token_hash,
        hold_expires_at,approval_expires_at,cancel_cutoff_at,attendance_status,attendance_score_applied,customer_name_snapshot,customer_phone_snapshot,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const seedApt = ({ customer, staff, service, day, hour, status, attendance = "pending", score = 0 }) => {
      const calc = calculateReservation([service], 10, 30);
      const start = trDayIso(day, hour);
      const serviceEnd = new Date(new Date(start).getTime() + calc.serviceMinutes * 60_000).toISOString();
      const end = new Date(new Date(start).getTime() + calc.reservedMinutes * 60_000).toISOString();
      const customerRow = db.prepare("SELECT * FROM customers WHERE id=?").get(customer);
      const aptId = Number(insertAppointment.run(
        tenantId, customer, staff, staff, JSON.stringify([staff]), "direct", status, start, serviceEnd, end,
        calc.serviceMinutes, 10, calc.reservedMinutes, calc.totalPriceKurus, calc.depositKurus,
        status === "cancelled" ? calc.totalPriceKurus : 0, status === "completed" || status === "no_show" ? calc.totalPriceKurus : 0,
        tokenHash(newToken()), tokenHash(newToken()), new Date(Date.now() - 60_000).toISOString(),
        status === "pending_approval" ? new Date(Date.now() + 25 * 60_000).toISOString() : null,
        new Date(new Date(start).getTime() - 3 * 3_600_000).toISOString(), attendance, score,
        customerRow.full_name, customerRow.phone, now, now
      ).lastInsertRowid);
      db.prepare("INSERT INTO appointment_services(appointment_id,service_id,name_snapshot,price_kurus_snapshot,duration_min_snapshot) VALUES(?,?,?,?,?)")
        .run(aptId, service.id, service.name, service.price_kurus, service.duration_min);
      if (["pending_approval", "confirmed", "completed", "no_show"].includes(status)) {
        db.prepare("INSERT INTO payments(tenant_id,appointment_id,provider,provider_payment_ref,amount_kurus,status,refund_kurus,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
          .run(tenantId, aptId, "demo", `demo_seed_${aptId}`, calc.totalPriceKurus, "succeeded", 0, now, now);
      }
      return aptId;
    };
    const pendingId = seedApt({ customer: customer2Id, staff: staffIds[0], service: services[0], day: 1, hour: 11, status: "pending_approval" });
    const confirmedId = seedApt({ customer: customerId, staff: staffIds[1], service: services[2], day: 1, hour: 14, status: "confirmed" });
    const completedId = seedApt({ customer: customerId, staff: staffIds[1], service: services[0], day: -1, hour: 15, status: "completed", attendance: "arrived" });
    db.prepare("INSERT INTO reviews(tenant_id,appointment_id,customer_id,stars,comment,created_at) VALUES(?,?,?,?,?,?)")
      .run(tenantId, completedId, customerId, 5, "Çok özenli ve tam saatinde başladı.", now);
    const staffUser = db.prepare("SELECT user_id FROM staff_profiles WHERE id=?").get(staffIds[0]);
    db.prepare("INSERT INTO notifications(tenant_id,user_id,appointment_id,kind,title,body,requires_action,dedupe_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(tenantId, staffUser.user_id, pendingId, "approval_required", "Yeni randevu onayı", "Mert Demir için 30 dakikalık ödeme sonrası onay süresi başladı.", 1, `seed-approval-${pendingId}`, now);
    const adminId = db.prepare("SELECT id FROM users WHERE tenant_id=? AND role='business_admin'").get(tenantId).id;
    db.prepare("INSERT INTO notifications(tenant_id,user_id,appointment_id,kind,title,body,dedupe_key,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(tenantId, adminId, confirmedId, "booking_confirmed", "Randevu onaylandı", "Selin Yılmaz randevusu Elif Uzman tarafından onaylandı.", `seed-confirm-${confirmedId}`, now);
    db.prepare("INSERT INTO audit_events(tenant_id,appointment_id,event_type,detail_json,created_at) VALUES(?,?,?,?,?)")
      .run(tenantId, completedId, "demo_seeded", JSON.stringify({ note: "Örnek tamamlanan randevu" }), now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function withImmediateTransaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
