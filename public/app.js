const app = document.querySelector("#app");
const toastRegion = document.querySelector("#toast-region");
const params = new URLSearchParams(location.search);
const tenantSlug = params.get("isletme") || "yakupberber";
const route = location.pathname === "/" ? "/randevu" : location.pathname;
let bootstrap = null;
let deferredInstall = null;

const state = {
  selectedServices: new Set(), staffId: "", date: tomorrowDate(), slots: [], selectedSlot: null,
  calculation: null, verificationToken: "", verifiedPhone: "", hold: null, manageToken: localStorage.getItem("er_manage_token") || "",
  adminTab: "overview", staffTab: "appointments",
};

function tomorrowDate() {
  const date = new Date(Date.now() + 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function e(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function money(kurus) { return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(Number(kurus || 0) / 100); }
function dateTime(value) { return new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function time(value) { return new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function day(value) { return new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", weekday: "short", day: "2-digit", month: "short" }).format(new Date(value)); }

function toast(message, type = "") {
  const item = document.createElement("div"); item.className = `toast ${type}`; item.textContent = message; toastRegion.append(item);
  setTimeout(() => item.remove(), 4200);
}

async function api(path, options = {}) {
  const url = new URL(path, location.origin);
  if (!url.searchParams.has("isletme") && !path.startsWith("/api/platform")) url.searchParams.set("isletme", tenantSlug);
  const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "İşlem tamamlanamadı"); error.code = payload.error?.code; error.status = response.status; throw error;
  }
  return payload;
}

function setBrand(tenant) {
  if (!tenant) return;
  document.documentElement.style.setProperty("--primary", tenant.primaryColor);
  document.documentElement.style.setProperty("--accent", tenant.accentColor);
  document.querySelector("#app-name").textContent = tenant.appName;
  document.querySelector("#business-name").textContent = tenant.name;
  document.querySelector("#brand-mark").innerHTML = tenant.hasLogo ? `<img src="/api/public/logo?isletme=${encodeURIComponent(tenant.slug)}" alt="">` : e(tenant.logoText);
  document.querySelector(".brand").href = `/randevu?isletme=${encodeURIComponent(tenant.slug)}`;
  document.querySelectorAll('.topnav a[href^="/randevu"],.topnav a[href^="/personel"],.topnav a[href^="/yonetici"]').forEach((link) => {
    const target = new URL(link.href); link.href = `${target.pathname}?isletme=${encodeURIComponent(tenant.slug)}`;
  });
  document.title = `${tenant.appName} · ${tenant.name}`;
  document.querySelector('link[rel="manifest"]').href = `/manifest.webmanifest?isletme=${tenant.slug}`;
  document.querySelector('link[rel="icon"]').href = `/favicon.svg?isletme=${tenant.slug}`;
}

function setActiveNav() {
  document.querySelectorAll(".topnav a").forEach((link) => {
    if (new URL(link.href).pathname === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

const statusMap = {
  held: ["Saat tutuldu", "warning"], expired: ["Süresi doldu", "danger"], pending_approval: ["Onay bekliyor", "warning"],
  confirmed: ["Onaylandı", "success"], completed: ["Tamamlandı", "success"], cancelled: ["İptal", "danger"], no_show: ["Gelmedi", "danger"],
};
function badge(status) { const item = statusMap[status] || [status, "info"]; return `<span class="badge ${item[1]}">${item[0]}</span>`; }

async function loadBootstrap() {
  bootstrap = await api("/api/public/bootstrap"); setBrand(bootstrap.tenant); return bootstrap;
}

function bookingSummary() {
  const services = bootstrap.services.filter((item) => state.selectedServices.has(item.id));
  const total = services.reduce((sum, item) => sum + item.priceKurus, 0);
  const duration = services.reduce((sum, item) => sum + item.durationMin, 0);
  const selectedStaff = bootstrap.staff.find((item) => String(item.id) === String(state.staffId));
  const calc = state.calculation;
  return `
    <div class="summary-card">
      <div class="summary-head"><h3>Randevu özeti</h3></div>
      <div class="summary-body">
        <div class="summary-line"><span>Hizmetler</span><strong>${services.length ? services.map((item) => e(item.name)).join(" + ") : "Henüz seçilmedi"}</strong></div>
        <div class="summary-line"><span>Hizmet süresi</span><strong>${duration ? `${duration} dk` : "—"}</strong></div>
        <div class="summary-line"><span>Takvim aralığı</span><strong>${calc ? `${calc.reservedMinutes} dk` : "—"}</strong></div>
        <div class="summary-line"><span>Çalışan</span><strong>${selectedStaff ? e(selectedStaff.name) : "Uygun ekip havuzu"}</strong></div>
        <div class="summary-line"><span>Saat</span><strong>${state.selectedSlot ? `${day(state.selectedSlot.startAt)} · ${time(state.selectedSlot.startAt)}` : "—"}</strong></div>
        <div class="summary-line"><span>Peşin ödeme</span><strong class="money">${money(total)}</strong></div>
        <div class="summary-line"><span>Geç iptal kesintisi</span><strong>${bootstrap.tenant.depositRate}% · ${money(Math.round(total * bootstrap.tenant.depositRate / 100))}</strong></div>
      </div>
    </div>
    <div class="policy-box"><strong>Net iade kuralı</strong>Randevudan ${bootstrap.tenant.cancellationHours} saat öncesine kadar tam iade. Sonrasında yalnız ${bootstrap.tenant.depositRate}% kapora tutulur; gelmeme durumunda iade yapılmaz.</div>
    <div class="status-banner info">Birden çok hizmeti aynı çalışan tamamlar. Seçilen saat, hizmet süresi + ${bootstrap.tenant.bufferMinutes} dk pay eklenerek sonraki 15 dakikaya yuvarlanır.</div>`;
}

function updateBookingSummary() { const target = document.querySelector("#booking-summary"); if (target) target.innerHTML = bookingSummary(); }

function renderBooking() {
  const tenant = bootstrap.tenant;
  app.innerHTML = `
    <section class="booking-layout">
      <div>
        <div class="booking-intro">
          <p class="eyebrow">${e(tenant.name)}</p>
          <h1>Kendinize uygun zamanı birkaç adımda ayırın.</h1>
          <p>Hizmetinizi, saatinizi ve isterseniz çalışanınızı seçin. Ödeme boyunca saat 5 dakika sizin için tutulur.</p>
          <div class="trust-row"><span class="trust-pill">Tam fiyat baştan görünür</span><span class="trust-pill">Net iptal kuralı</span><span class="trust-pill">Telefon doğrulamalı</span></div>
        </div>
        <div class="booking-main">
          ${!tenant.subscriptionActive ? '<div class="status-banner danger"><strong>Yeni randevu geçici olarak kapalı.</strong> Abonelik süresi doldu; mevcut randevular yönetilmeye devam eder.</div>' : ""}
          <section class="step-card" aria-labelledby="service-title">
            <div class="step-head"><div class="step-title"><span class="step-number">1</span><div><h2 id="service-title">Hizmetlerinizi seçin</h2><p class="step-status">Birden fazla seçim yapabilirsiniz</p></div></div></div>
            <div class="service-grid" id="service-grid">${bootstrap.services.map((item) => `
              <label class="service-option" data-service-card="${item.id}">
                <input type="checkbox" value="${item.id}" ${state.selectedServices.has(item.id) ? "checked" : ""}>
                <span class="service-copy"><strong>${e(item.name)}</strong><small>${item.durationMin} dakika</small></span>
                <span class="service-price money">${money(item.priceKurus)}</span>
              </label>`).join("")}</div>
          </section>
          <section class="step-card" aria-labelledby="time-title">
            <div class="step-head"><div class="step-title"><span class="step-number">2</span><div><h2 id="time-title">Saat ve çalışan</h2><p class="step-status">Tüm süre boyunca uygunluk kontrol edilir</p></div></div></div>
            <div class="filter-grid">
              <label class="field"><span>Tarih</span><input id="booking-date" type="date" min="${tomorrowDate()}" value="${state.date}"></label>
              <label class="field"><span>Çalışan</span><select id="booking-staff"><option value="">Fark etmez · ortak havuz</option>${bootstrap.staff.map((item) => `<option value="${item.id}">${e(item.name)}</option>`).join("")}</select></label>
            </div>
            <button class="wide" id="availability-button" type="button" ${tenant.subscriptionActive ? "" : "disabled"}>Uygun saatleri göster</button>
            <div id="calculation-strip"></div><div id="slot-grid" class="slot-grid"></div>
          </section>
          <section class="step-card" aria-labelledby="contact-title">
            <div class="step-head"><div class="step-title"><span class="step-number">3</span><div><h2 id="contact-title">İletişim bilgileri</h2><p class="step-status">İsim tekil anahtar değildir; randevu telefonla eşleşir</p></div></div></div>
            <div class="form-grid">
              <label class="field"><span>Ad soyad</span><input id="customer-name" autocomplete="name" placeholder="Örn. Deniz Yılmaz"></label>
              <label class="field"><span>Telefon</span><div class="inline"><input id="customer-phone" type="tel" autocomplete="tel" placeholder="05xx xxx xx xx"><button class="secondary" id="send-code" type="button">Kod al</button></div></label>
            </div>
            <div id="otp-area"></div>
          </section>
          <section class="step-card" aria-labelledby="payment-title">
            <div class="step-head"><div class="step-title"><span class="step-number">4</span><div><h2 id="payment-title">Saati tut ve ödemeye geç</h2><p class="step-status">Kart bilgisi E‑Randevum sunucusuna hiç gelmez</p></div></div></div>
            <div id="checkout-area">
              <div class="status-banner warning">Bu sürümde hosted ödeme sağlayıcısı yerine güvenli sınırı gösteren demo adaptörü kullanılır. Gerçek tahsilat yapılmaz.</div>
              <button class="wide" id="hold-button" type="button" ${tenant.subscriptionActive ? "" : "disabled"}>5 dakika tut ve demo ödemeyi aç</button>
            </div>
          </section>
        </div>
      </div>
      <aside class="booking-aside" id="booking-summary">${bookingSummary()}</aside>
    </section>`;
  document.querySelector("#booking-staff").value = state.staffId;
  bindBooking();
}

function bindBooking() {
  document.querySelectorAll("#service-grid input").forEach((input) => input.addEventListener("change", () => {
    const id = Number(input.value); input.checked ? state.selectedServices.add(id) : state.selectedServices.delete(id);
    input.closest(".service-option").classList.toggle("selected", input.checked); state.slots = []; state.selectedSlot = null; state.calculation = null;
    document.querySelector("#slot-grid").innerHTML = ""; document.querySelector("#calculation-strip").innerHTML = ""; updateBookingSummary();
  }));
  document.querySelectorAll("#service-grid input:checked").forEach((input) => input.closest(".service-option").classList.add("selected"));
  document.querySelector("#booking-date").addEventListener("change", (event) => { state.date = event.target.value; state.selectedSlot = null; updateBookingSummary(); });
  document.querySelector("#booking-staff").addEventListener("change", (event) => { state.staffId = event.target.value; state.selectedSlot = null; updateBookingSummary(); });
  document.querySelector("#availability-button").addEventListener("click", loadAvailability);
  document.querySelector("#send-code").addEventListener("click", requestPhoneCode);
  document.querySelector("#hold-button").addEventListener("click", createHold);
}

async function loadAvailability() {
  if (!state.selectedServices.size) return toast("Önce en az bir hizmet seçin", "error");
  const button = document.querySelector("#availability-button"); button.disabled = true; button.textContent = "Takvimler kontrol ediliyor…";
  try {
    const query = new URLSearchParams({ date: state.date, serviceIds: [...state.selectedServices].join(",") });
    if (state.staffId) query.set("staffId", state.staffId);
    const result = await api(`/api/public/availability?${query}`); state.slots = result.slots; state.calculation = result.calculation; state.selectedSlot = null;
    document.querySelector("#calculation-strip").innerHTML = `<div class="calculation-strip"><span>Hizmet: ${result.calculation.serviceMinutes} dk</span><span>Hazırlık payı: ${result.calculation.bufferMinutes} dk</span><span>Önerilen takvim aralığı: ${result.calculation.reservedMinutes} dk</span></div>`;
    const grid = document.querySelector("#slot-grid");
    grid.innerHTML = result.slots.length ? result.slots.map((slot, index) => `<button class="slot" data-slot="${index}" type="button"><strong>${time(slot.startAt)}</strong><small>${slot.availableStaff.length} uygun çalışan</small></button>`).join("") : `<div class="empty-state" style="grid-column:1/-1">Bu gün için uygun aralık bulunamadı. Başka bir tarih veya çalışan deneyin.</div>`;
    grid.querySelectorAll("[data-slot]").forEach((slotButton) => slotButton.addEventListener("click", () => {
      grid.querySelectorAll(".slot").forEach((item) => item.classList.remove("selected")); slotButton.classList.add("selected"); state.selectedSlot = state.slots[Number(slotButton.dataset.slot)]; updateBookingSummary();
    }));
    updateBookingSummary();
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; button.textContent = "Uygun saatleri göster"; }
}

async function requestPhoneCode() {
  const phone = document.querySelector("#customer-phone").value; if (!phone) return toast("Telefon numaranızı girin", "error");
  try {
    const result = await api("/api/public/phone/request", { method: "POST", body: JSON.stringify({ phone }) });
    document.querySelector("#otp-area").innerHTML = `<div class="otp-panel"><p><strong>Demo SMS:</strong> Gerçek mesaj gönderilmedi. Bu yerel sürümde kod <strong>${e(result.demoCode)}</strong>.</p><div class="inline"><input id="otp-code" inputmode="numeric" value="123456" aria-label="Doğrulama kodu"><button id="verify-code" type="button">Doğrula</button></div></div>`;
    document.querySelector("#verify-code").addEventListener("click", confirmPhone);
  } catch (error) { toast(error.message, "error"); }
}

async function confirmPhone() {
  const phone = document.querySelector("#customer-phone").value; const code = document.querySelector("#otp-code").value;
  try {
    const result = await api("/api/public/phone/confirm", { method: "POST", body: JSON.stringify({ phone, code }) });
    state.verificationToken = result.verificationToken; state.verifiedPhone = result.phone;
    document.querySelector("#otp-area").innerHTML = `<div class="status-banner success">Telefon demo doğrulaması tamamlandı. Üretimde gerçek SMS sağlayıcısı gerekir.</div>`;
    toast("Telefon doğrulandı");
  } catch (error) { toast(error.message, "error"); }
}

async function createHold() {
  const fullName = document.querySelector("#customer-name").value; const phone = document.querySelector("#customer-phone").value;
  if (!state.selectedSlot) return toast("Uygun bir saat seçin", "error");
  if (!state.verificationToken) return toast("Telefonunuzu doğrulayın", "error");
  const button = document.querySelector("#hold-button"); button.disabled = true; button.textContent = "Saat atomik olarak tutuluyor…";
  try {
    state.hold = await api("/api/public/holds", { method: "POST", body: JSON.stringify({ fullName, phone, verificationToken: state.verificationToken, serviceIds: [...state.selectedServices], staffId: state.staffId || null, startAt: state.selectedSlot.startAt }) });
    state.manageToken = state.hold.manageToken; localStorage.setItem("er_manage_token", state.manageToken);
    const expires = new Date(state.hold.holdExpiresAt);
    document.querySelector("#checkout-area").innerHTML = `
      <div class="status-banner success"><strong>Saat 5 dakika tutuldu.</strong> ${time(expires)} zamanına kadar demo ödemeyi tamamlayın.</div>
      <div class="panel" style="margin-top:.8rem"><p class="eyebrow">HOSTED ÖDEME DEMOSU</p><h3 style="margin:.35rem 0">${money(state.hold.payment.amountKurus)} · kart alanı yok</h3><p class="tiny">Gerçek sağlayıcıda bu düğme işletmenin kendi ödeme hesabındaki sağlayıcı sayfasına yönlendirir. Platform komisyonu: 0.</p><button class="wide" id="pay-demo" style="margin-top:1rem" type="button">Sağlayıcıdan başarılı ödeme bildirimi gönder</button></div>`;
    document.querySelector("#pay-demo").addEventListener("click", completePayment);
  } catch (error) { toast(error.message, "error"); button.disabled = false; button.textContent = "5 dakika tut ve demo ödemeyi aç"; }
}

async function completePayment() {
  const button = document.querySelector("#pay-demo"); button.disabled = true; button.textContent = "Bildirim işleniyor…";
  try {
    const result = await api("/api/public/payments/mock-complete", { method: "POST", body: JSON.stringify({ holdToken: state.hold.holdToken, providerEventId: `browser_${Date.now()}` }) });
    document.querySelector("#checkout-area").innerHTML = result.status === "pending_approval" ? `
      <div class="status-banner success"><strong>Demo ödeme başarılı.</strong> Çalışan onayı ${dateTime(result.approvalExpiresAt)} tarihine kadar bekleniyor.</div>
      <button class="wide secondary" id="track-booking" type="button">Randevu durumunu görüntüle</button>` : `<div class="status-banner warning">${e(result.message)}</div>`;
    document.querySelector("#track-booking")?.addEventListener("click", renderManagedAppointment);
  } catch (error) { toast(error.message, "error"); button.disabled = false; button.textContent = "Sağlayıcıdan başarılı ödeme bildirimi gönder"; }
}

async function renderManagedAppointment() {
  if (!state.manageToken) return toast("Bu tarayıcıda randevu yönetim kodu yok", "error");
  try {
    const result = await api(`/api/public/appointment?token=${encodeURIComponent(state.manageToken)}`); const apt = result.appointment;
    document.querySelector("#checkout-area").innerHTML = `<div class="status-banner ${statusMap[apt.status]?.[1] || "info"}"><strong>${statusMap[apt.status]?.[0] || apt.status}</strong><br>${dateTime(apt.start_at)} · ${apt.staff_name || "Uygun çalışan havuzu"}</div>
      ${["pending_approval", "confirmed"].includes(apt.status) ? `<button class="wide danger" id="cancel-managed" type="button">Randevuyu iptal et</button>` : ""}
      <p class="tiny">Yönetim kodu yalnız bu tarayıcıda saklandı. Üretimde doğrulanmış telefona güvenli bağlantı gönderilir.</p>`;
    document.querySelector("#cancel-managed")?.addEventListener("click", async () => {
      if (!confirm("İptal ve iade politikasını uygulamak istiyor musunuz?")) return;
      try { const cancelled = await api(`/api/public/appointments/${apt.id}/cancel`, { method: "POST", body: JSON.stringify({ manageToken: state.manageToken }) }); toast(`İptal tamamlandı. İade: ${money(cancelled.outcome.refundKurus)}`); renderManagedAppointment(); } catch (error) { toast(error.message, "error"); }
    });
  } catch (error) { toast(error.message, "error"); }
}

function loginView(role) {
  const copy = role === "staff" ? { title: "Personel takvimi", text: "Randevularınızı kabul edin, müşterinin gelişini kesinleştirin ve kalıcı görev bildirimlerini yönetin.", username: "ahmet", password: "Usta123!", button: "Personel olarak aç" }
    : role === "business_admin" ? { title: "İşletme yönetimi", text: "Takvim, personel, hizmet, müşteri sayısı, gelir, yorum ve işletme ayarlarını tek yerden yönetin.", username: "yonetici", password: "Demo123!", button: "Yönetici olarak aç" }
      : { title: "Platform merkezi", text: "İşletme hesapları, sabit abonelik bitişleri ve sistem durumunu yönetin. Müşteri, yorum ve gelir ayrıntıları burada gösterilmez.", username: "platform", password: "Platform123!", button: "Platform olarak aç" };
  app.innerHTML = `<section class="login-wrap"><div class="login-story"><p class="eyebrow">E-RANDEVUM</p><h1>${copy.title}</h1><p>${copy.text}</p></div><div class="login-card"><h2>Demo oturumu</h2><p class="muted">İlk çalışan sürümde güvenli scrypt şifre özeti ve sunucu oturumu kullanılır.</p><form id="login-form">
    <label class="field"><span>Kullanıcı adı</span><input name="username" value="${copy.username}" autocomplete="username"></label>
    <label class="field"><span>Şifre</span><input name="password" type="password" value="${copy.password}" autocomplete="current-password"></label>
    <button type="submit">${copy.button}</button></form><div class="demo-credentials">Demo: <code>${copy.username}</code> / <code>${copy.password}</code>${role === "staff" ? "<br>Diğer personel: elif veya derya / Usta123!" : ""}</div></div></section>`;
  document.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const button = event.currentTarget.querySelector("button"); button.disabled = true;
    try { await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password"), tenantSlug, role }) }); document.querySelector("#logout-button").classList.remove("hidden"); await routeApp(); }
    catch (error) { toast(error.message, "error"); button.disabled = false; }
  });
}

async function renderStaff() {
  let data;
  try { data = await api("/api/staff/dashboard"); } catch (error) { if (error.status === 401 || error.status === 403) return loginView("staff"); throw error; }
  document.querySelector("#logout-button").classList.remove("hidden");
  const upcoming = data.appointments.filter((item) => ["pending_approval", "confirmed", "no_show"].includes(item.status));
  const actionCount = data.notifications.filter((item) => item.requires_action && !item.resolved_at).length;
  app.innerHTML = `<section class="dashboard-shell"><aside class="sidebar"><div class="sidebar-user"><strong>${e(data.staff.name)}</strong><small>Personel hesabı</small></div><nav><button data-tab="appointments" class="active">Randevular</button><button data-tab="notifications">Bildirimler ${actionCount ? `(${actionCount})` : ""}</button><button data-tab="account">Hesabım</button></nav></aside><div class="dashboard-content" id="dashboard-view"></div></section>`;
  const renderTab = () => {
    document.querySelectorAll(".sidebar [data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === state.staffTab));
    const view = document.querySelector("#dashboard-view");
    if (state.staffTab === "appointments") view.innerHTML = `<div class="page-head"><div><p class="eyebrow">BUGÜN VE YAKLAŞANLAR</p><h1>Takviminiz</h1><p>Havuz taleplerini ilk kabul eden çalışan atomik olarak alır.</p></div><span class="badge info">${upcoming.length} aktif kayıt</span></div>
      ${data.user.mustChangePassword ? '<div class="status-banner warning">İlk şifrenizi Hesabım bölümünden değiştirin.</div>' : ""}<div class="appointment-list">${upcoming.length ? upcoming.map((apt) => `
        <article class="appointment-card"><div class="appointment-time"><span>${day(apt.start_at)}</span><strong>${time(apt.start_at)}</strong><small>${apt.reserved_minutes} dk blok</small></div><div class="appointment-copy"><div class="inline" style="justify-content:flex-start"><h3>${e(apt.customer_name_snapshot)}</h3>${badge(apt.status)}</div><p>${apt.services.map((item) => e(item.name)).join(" + ")} · ${money(apt.charge_kurus)} · gelmeme puanı ${apt.no_show_score}</p><p>${apt.selection_mode === "pool" && !apt.staff_id ? "Ortak havuz · yalnız bir çalışan kapasitesi korunuyor" : "Doğrudan takviminiz"}</p></div><div class="appointment-actions">
          ${apt.status === "pending_approval" ? `<button data-accept="${apt.id}">Kabul et</button>` : ""}
          ${["confirmed", "no_show"].includes(apt.status) && apt.staff_id === data.staff.id ? `<button class="ghost" data-attendance="arrived" data-id="${apt.id}">Geldi</button><button class="danger" data-attendance="no_show" data-id="${apt.id}">Gelmedi</button><button data-attendance="completed" data-id="${apt.id}">Tamamlandı</button>` : ""}
        </div></article>`).join("") : '<div class="empty-state">Aktif randevu yok.</div>'}</div>`;
    else if (state.staffTab === "notifications") view.innerHTML = `<div class="page-head"><div><p class="eyebrow">UYGULAMA İÇİ KUTU</p><h1>Bildirimler</h1><p>Okumak, işlem gerektiren “müşteri geldi mi?” görevini kapatmaz.</p></div></div><div class="notification-list">${data.notifications.length ? data.notifications.map((item) => `<article class="notification ${item.read_at ? "" : "unread"} ${item.requires_action && !item.resolved_at ? "action" : ""}"><div><div class="inline" style="justify-content:flex-start"><strong>${e(item.title)}</strong>${item.requires_action && !item.resolved_at ? '<span class="badge warning">İşlem gerekli</span>' : ""}</div><p>${e(item.body)}</p><small class="tiny">${dateTime(item.created_at)} · Push: ${e(item.push_status)}</small></div>${!item.read_at ? `<button class="secondary compact" data-read="${item.id}">Okundu</button>` : ""}</article>`).join("") : '<div class="empty-state">Bildirim yok.</div>'}</div>`;
    else view.innerHTML = `<div class="page-head"><div><p class="eyebrow">GÜVENLİK</p><h1>Şifrenizi değiştirin</h1></div></div><div class="panel" style="max-width:520px"><form id="password-form" class="form-grid" style="grid-template-columns:1fr"><label class="field"><span>Mevcut şifre</span><input name="currentPassword" type="password"></label><label class="field"><span>Yeni şifre</span><input name="newPassword" type="password" placeholder="En az 8 karakter, büyük/küçük harf ve rakam"></label><button>Şifreyi değiştir</button></form></div>`;
    bindStaffActions(renderTab);
  };
  document.querySelectorAll(".sidebar [data-tab]").forEach((button) => button.addEventListener("click", () => { state.staffTab = button.dataset.tab; renderTab(); })); renderTab();
}

function bindStaffActions() {
  document.querySelectorAll("[data-accept]").forEach((button) => button.addEventListener("click", async () => { try { await api(`/api/staff/appointments/${button.dataset.accept}/accept`, { method: "POST", body: "{}" }); toast("Randevu takviminize atandı"); await renderStaff(); } catch (error) { toast(error.message, "error"); } }));
  document.querySelectorAll("[data-attendance]").forEach((button) => button.addEventListener("click", async () => { try { await api(`/api/staff/appointments/${button.dataset.id}/attendance`, { method: "POST", body: JSON.stringify({ action: button.dataset.attendance }) }); toast("Devam durumu kaydedildi"); await renderStaff(); } catch (error) { toast(error.message, "error"); } }));
  document.querySelectorAll("[data-read]").forEach((button) => button.addEventListener("click", async () => { try { const result = await api(`/api/notifications/${button.dataset.read}/read`, { method: "POST", body: "{}" }); toast(result.note || "Bildirim okundu"); await renderStaff(); } catch (error) { toast(error.message, "error"); } }));
  document.querySelector("#password-form")?.addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api("/api/auth/change-password", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); toast("Şifre değiştirildi"); await renderStaff(); } catch (error) { toast(error.message, "error"); } });
}

function adminSidebar(data) {
  const tabs = [["overview", "Özet"], ["appointments", "Randevular"], ["staff", "Personel"], ["services", "Hizmetler"], ["customers", "Müşteriler"], ["reviews", "Yorumlar"], ["notifications", "Bildirimler"], ["settings", "Ayarlar"], ["audit", "Denetim izi"]];
  return `<aside class="sidebar"><div class="sidebar-user"><strong>${e(data.tenant.name)}</strong><small>İşletme yöneticisi</small></div><nav>${tabs.map(([id, title]) => `<button data-tab="${id}" class="${state.adminTab === id ? "active" : ""}">${title}</button>`).join("")}</nav></aside>`;
}

async function renderAdmin() {
  let data;
  try { data = await api("/api/admin/dashboard"); } catch (error) { if (error.status === 401 || error.status === 403) return loginView("business_admin"); throw error; }
  document.querySelector("#logout-button").classList.remove("hidden"); setBrand(data.tenant);
  app.innerHTML = `<section class="dashboard-shell">${adminSidebar(data)}<div class="dashboard-content" id="dashboard-view"></div></section>`;
  const renderTab = () => {
    document.querySelectorAll(".sidebar [data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === state.adminTab));
    const view = document.querySelector("#dashboard-view"); const activeApts = data.appointments.filter((item) => ["pending_approval", "confirmed"].includes(item.status));
    if (state.adminTab === "overview") view.innerHTML = `<div class="page-head"><div><p class="eyebrow">İŞLETME DURUMU</p><h1>Bugünün nabzı</h1><p>Abonelik bitişi: ${dateTime(data.subscriptionEndsAt)}</p></div><span class="badge ${data.tenant.subscriptionActive ? "success" : "danger"}">${data.tenant.subscriptionActive ? "Yeni randevu açık" : "Yeni randevu kapalı"}</span></div><div class="metric-grid">
      <div class="metric"><small>Aktif randevu</small><strong>${activeApts.length}</strong><em>onay bekleyen + onaylı</em></div><div class="metric"><small>Brüt ödeme</small><strong>${money(data.revenue.grossKurus)}</strong><em>${data.revenue.paidCount} işlem</em></div><div class="metric"><small>İade</small><strong>${money(data.revenue.refundKurus)}</strong><em>tam + kısmi</em></div><div class="metric"><small>Net tutulan</small><strong>${money(data.revenue.netKurus)}</strong><em>işletme ödeme hesabı</em></div></div>
      <div class="split-panels"><section class="panel"><div class="panel-head"><h2>Yaklaşan randevular</h2></div><div class="appointment-list">${activeApts.slice(0,5).map((apt) => `<article class="appointment-card" style="grid-template-columns:80px 1fr"><div class="appointment-time"><strong>${time(apt.start_at)}</strong><small>${day(apt.start_at)}</small></div><div class="appointment-copy"><h3>${e(apt.customer_name_snapshot)}</h3><p>${apt.services.map((item) => e(item.name)).join(" + ")} · ${e(apt.staff_name || "Havuz")}</p></div></article>`).join("") || '<div class="empty-state">Yaklaşan kayıt yok.</div>'}</div></section>
      <section class="panel"><div class="panel-head"><h2>Çalışan görünümü</h2></div><div class="table-wrap"><table><thead><tr><th>Çalışan</th><th>Tekil müşteri</th><th>Hesap</th></tr></thead><tbody>${data.staff.map((item) => `<tr><td><strong>${e(item.name)}</strong><br><small>${e(item.username)}</small></td><td>${item.customer_count}</td><td>${item.account_active ? '<span class="badge success">Açık</span>' : '<span class="badge danger">Kapalı</span>'}</td></tr>`).join("")}</tbody></table></div></section></div>`;
    else if (state.adminTab === "appointments") view.innerHTML = `<div class="page-head"><div><p class="eyebrow">TÜM KAYITLAR</p><h1>Randevular</h1><p>Hizmet bitişi ve önerilen takvim aralığı ayrı gösterilir.</p></div></div><section class="panel"><div class="table-wrap"><table><thead><tr><th>Zaman</th><th>Müşteri</th><th>Hizmet / aralık</th><th>Çalışan</th><th>Ödeme</th><th>Durum</th><th>İşlem</th></tr></thead><tbody>${data.appointments.map((apt) => `<tr><td><strong>${dateTime(apt.start_at)}</strong><br><small>Hizmet sonu ${time(apt.service_end_at)} · blok sonu ${time(apt.end_at)}</small></td><td>${e(apt.customer_name_snapshot)}<br><small>${e(apt.customer_phone_snapshot)}</small></td><td>${apt.services.map((item) => e(item.name)).join(" + ")}<br><small>${apt.total_service_minutes}+${apt.buffer_minutes} → ${apt.reserved_minutes} dk</small></td><td>${e(apt.staff_name || "Havuz")}</td><td>${money(apt.charge_kurus)}<br><small>İade ${money(apt.refund_kurus)}</small></td><td>${badge(apt.status)}</td><td><div class="table-actions">${["pending_approval","confirmed"].includes(apt.status) ? `<button class="danger compact" data-admin-cancel="${apt.id}">İptal</button>` : ""}${["confirmed","no_show"].includes(apt.status) ? `<button class="ghost compact" data-admin-attendance="arrived" data-id="${apt.id}">Geldi</button><button class="compact" data-admin-attendance="completed" data-id="${apt.id}">Bitti</button>` : ""}</div></td></tr>`).join("")}</tbody></table></div></section>`;
    else if (state.adminTab === "staff") view.innerHTML = `<div class="page-head"><div><p class="eyebrow">HESAPLAR VE YETKİLER</p><h1>Personel</h1><p>Hesap kapanınca eski randevu kayıtları korunur.</p></div></div><div class="split-panels"><section class="panel"><div class="panel-head"><h2>Personel listesi</h2></div><div class="table-wrap"><table><thead><tr><th>Ad</th><th>Kullanıcı</th><th>Müşteri</th><th>Durum</th><th></th></tr></thead><tbody>${data.staff.map((item) => `<tr><td>${e(item.name)}</td><td>${e(item.username)}</td><td>${item.customer_count}</td><td>${item.account_active ? '<span class="badge success">Açık</span>' : '<span class="badge danger">Kapalı</span>'}</td><td><button class="secondary compact" data-staff-toggle="${item.id}">${item.account_active ? "Kapat" : "Aç"}</button></td></tr>`).join("")}</tbody></table></div></section><section class="panel"><div class="panel-head"><h2>Yeni personel</h2></div><form id="staff-form" class="form-grid" style="grid-template-columns:1fr"><label class="field"><span>Ad soyad</span><input name="name" required></label><label class="field"><span>Kullanıcı adı</span><input name="username" pattern="[a-z0-9._-]{3,30}" required></label><label class="field"><span>İlk şifre</span><input name="initialPassword" value="Usta123!" required></label><label class="field"><span>Yetkin olduğu hizmetler</span><select name="serviceIds" multiple size="4">${data.services.filter((item)=>item.active).map((item)=>`<option value="${item.id}">${e(item.name)}</option>`).join("")}</select></label><button>Personeli oluştur</button></form></section></div>`;
    else if (state.adminTab === "services") view.innerHTML = `<div class="page-head"><div><p class="eyebrow">KATALOĞUNUZ</p><h1>Hizmetler</h1><p>Eski randevular fiyat/süre anlık görüntüsünü korur.</p></div></div><div class="split-panels"><section class="panel"><div class="table-wrap"><table><thead><tr><th>Hizmet</th><th>Fiyat</th><th>Süre</th><th>Durum</th><th></th></tr></thead><tbody>${data.services.map((item) => `<tr><td>${e(item.name)}</td><td>${money(item.priceKurus)}</td><td>${item.durationMin} dk</td><td>${item.active ? '<span class="badge success">Açık</span>' : '<span class="badge">Kapalı</span>'}</td><td><button class="secondary compact" data-service-toggle="${item.id}">${item.active ? "Kapat" : "Aç"}</button></td></tr>`).join("")}</tbody></table></div></section><section class="panel"><h2>Yeni hizmet</h2><form id="service-form" class="form-grid" style="grid-template-columns:1fr;margin-top:1rem"><label class="field"><span>Hizmet adı</span><input name="name" required></label><label class="field"><span>Fiyat (TL)</span><input name="priceTl" type="number" min="0" step="0.01" required></label><label class="field"><span>Ortalama süre (dk)</span><input name="durationMin" type="number" min="5" step="5" required></label><button>Hizmet ekle</button></form></section></div>`;
    else if (state.adminTab === "customers") view.innerHTML = `<div class="page-head"><div><p class="eyebrow">İŞLETME İÇİ</p><h1>Müşteriler</h1><p>Ad soyad tekil değildir; kayıt doğrulanmış telefonla eşleşir.</p></div></div><section class="panel"><div class="table-wrap"><table><thead><tr><th>Ad soyad</th><th>Telefon</th><th>Gelmeme puanı</th><th>İlk kayıt</th></tr></thead><tbody>${data.customers.map((item) => `<tr><td>${e(item.fullName)}</td><td>${e(item.phone)}</td><td><span class="badge ${item.noShowScore ? "danger" : "success"}">${item.noShowScore}</span></td><td>${dateTime(item.createdAt)}</td></tr>`).join("")}</tbody></table></div></section>`;
    else if (state.adminTab === "reviews") view.innerHTML = `<div class="page-head"><div><p class="eyebrow">YALNIZ İŞLETME SAHİBİ</p><h1>Değerlendirmeler</h1><p>Personel ve platform sahibi bu içerikleri göremez.</p></div></div><div class="appointment-list">${data.reviews.map((item) => `<article class="review-card"><span class="stars">${"★".repeat(item.stars)}${"☆".repeat(5-item.stars)}</span><p>${e(item.comment)}</p><small class="tiny">${e(item.customerName)} · ${dateTime(item.createdAt)}</small></article>`).join("") || '<div class="empty-state">Henüz yorum yok.</div>'}</div>`;
    else if (state.adminTab === "notifications") view.innerHTML = `<div class="page-head"><div><p class="eyebrow">TÜM OLAYLAR</p><h1>Bildirim merkezi</h1><p>Uygulama içi kutu aktiftir; üretim Web Push için VAPID ve teslimat servisi gerekir.</p></div></div><div class="notification-list">${data.notifications.map((item) => `<article class="notification ${item.read_at ? "" : "unread"} ${item.requires_action&&!item.resolved_at?"action":""}"><div><strong>${e(item.title)}</strong><p>${e(item.body)}</p><small class="tiny">${dateTime(item.created_at)} · ${e(item.push_status)}</small></div>${item.requires_action&&!item.resolved_at?'<span class="badge warning">Çözülmedi</span>':""}</article>`).join("") || '<div class="empty-state">Bildirim yok.</div>'}</div>`;
    else if (state.adminTab === "settings") view.innerHTML = `<div class="page-head"><div><p class="eyebrow">MARKA VE POLİTİKA</p><h1>İşletme ayarları</h1><p>Değişiklikler yeni randevulara uygulanır; eski kayıtların politika anlık görüntüsü korunur.</p></div></div><div class="split-panels"><section class="panel"><h2>Logo yükle</h2><p class="tiny" style="margin:.4rem 0 1rem">PNG, JPEG veya WebP · en fazla 180 KB. Dosya işletmenin kendi kaydında tutulur.</p><form id="logo-form"><label class="field"><span>Logo dosyası</span><input id="logo-file" type="file" accept="image/png,image/jpeg,image/webp" required></label><button style="margin-top:.8rem">Logoyu yükle</button></form></section><section class="panel"><form id="settings-form" class="form-grid"><label class="field"><span>Uygulama adı</span><input name="appName" value="${e(data.tenant.appName)}"></label><label class="field"><span>Logo harfleri</span><input name="logoText" maxlength="4" value="${e(data.tenant.logoText)}"></label><label class="field"><span>Ana renk</span><input name="primaryColor" type="color" value="${e(data.tenant.primaryColor)}"></label><label class="field"><span>Vurgu rengi</span><input name="accentColor" type="color" value="${e(data.tenant.accentColor)}"></label><label class="field"><span>Hazırlık payı (5–10 dk)</span><input name="bufferMinutes" type="number" min="5" max="10" value="${data.tenant.bufferMinutes}"></label><label class="field"><span>Kapora oranı (%)</span><input name="depositRate" type="number" min="0" max="100" value="${data.tenant.depositRate}"></label><label class="field"><span>Ücretsiz iptal sınırı (saat)</span><input name="cancellationHours" type="number" min="1" value="${data.tenant.cancellationHours}"></label><label class="field"><span>Onay süresi (dk)</span><input name="approvalMinutes" type="number" min="5" value="${data.tenant.approvalMinutes}"></label><label class="field"><span>Geliş toleransı (dk)</span><input name="graceMinutes" type="number" min="0" value="${data.tenant.graceMinutes}"></label><div><button>Kaydet</button></div></form></section></div>`;
    else view.innerHTML = `<div class="page-head"><div><p class="eyebrow">DEĞİŞMEZ KAYIT</p><h1>Denetim izi</h1><p>Onay, iptal, iade, geliş kararı ve düzeltmeler kaydedilir.</p></div></div><div class="audit-list">${data.audit.map((item) => `<article class="audit-row"><strong>${e(item.eventType)}</strong> · randevu ${item.appointmentId || "—"}<br><small>${dateTime(item.createdAt)} · ${e(item.detail)}</small></article>`).join("")}</div>`;
    bindAdminActions();
  };
  document.querySelectorAll(".sidebar [data-tab]").forEach((button) => button.addEventListener("click", () => { state.adminTab = button.dataset.tab; renderTab(); })); renderTab();
}

function bindAdminActions() {
  document.querySelectorAll("[data-admin-cancel]").forEach((button) => button.addEventListener("click", async () => { if (!confirm("Tam iade ile işletme iptali yapılsın mı?")) return; try { await api(`/api/admin/appointments/${button.dataset.adminCancel}/cancel`, { method: "POST", body: "{}" }); toast("Randevu iptal edildi; tam iade kaydedildi"); await renderAdmin(); } catch (error) { toast(error.message, "error"); } }));
  document.querySelectorAll("[data-admin-attendance]").forEach((button) => button.addEventListener("click", async () => { try { await api(`/api/admin/appointments/${button.dataset.id}/attendance`, { method: "POST", body: JSON.stringify({ action: button.dataset.adminAttendance }) }); toast("Kayıt audit iziyle düzeltildi"); await renderAdmin(); } catch (error) { toast(error.message, "error"); } }));
  document.querySelectorAll("[data-service-toggle]").forEach((button) => button.addEventListener("click", async () => { try { await api(`/api/admin/services/${button.dataset.serviceToggle}/toggle`, { method: "POST", body: "{}" }); await renderAdmin(); } catch (error) { toast(error.message, "error"); } }));
  document.querySelectorAll("[data-staff-toggle]").forEach((button) => button.addEventListener("click", async () => { try { await api(`/api/admin/staff/${button.dataset.staffToggle}/toggle`, { method: "POST", body: "{}" }); toast("Hesap durumu değişti; geçmiş korundu"); await renderAdmin(); } catch (error) { toast(error.message, "error"); } }));
  document.querySelector("#service-form")?.addEventListener("submit", async (event) => { event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget)); try { await api("/api/admin/services", { method: "POST", body: JSON.stringify(form) }); toast("Hizmet eklendi"); await renderAdmin(); } catch (error) { toast(error.message, "error"); } });
  document.querySelector("#staff-form")?.addEventListener("submit", async (event) => { event.preventDefault(); const fd = new FormData(event.currentTarget); const body = { name: fd.get("name"), username: fd.get("username"), initialPassword: fd.get("initialPassword"), serviceIds: fd.getAll("serviceIds").map(Number) }; try { await api("/api/admin/staff", { method: "POST", body: JSON.stringify(body) }); toast("Personel hesabı oluşturuldu"); await renderAdmin(); } catch (error) { toast(error.message, "error"); } });
  document.querySelector("#settings-form")?.addEventListener("submit", async (event) => { event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget)); for (const key of ["bufferMinutes","depositRate","cancellationHours","approvalMinutes","graceMinutes"]) form[key] = Number(form[key]); try { await api("/api/admin/settings", { method: "POST", body: JSON.stringify(form) }); toast("Ayarlar kaydedildi"); await loadBootstrap(); await renderAdmin(); } catch (error) { toast(error.message, "error"); } });
  document.querySelector("#logo-form")?.addEventListener("submit", async (event) => { event.preventDefault(); const file = document.querySelector("#logo-file").files[0]; if (!file) return; if (file.size > 180000) return toast("Logo 180 KB sınırını aşıyor", "error"); const reader = new FileReader(); reader.onload = async () => { try { await api("/api/admin/branding/logo", { method: "POST", body: JSON.stringify({ dataUrl: reader.result }) }); toast("Logo yüklendi"); await loadBootstrap(); await renderAdmin(); } catch (error) { toast(error.message, "error"); } }; reader.readAsDataURL(file); });
}

async function renderPlatform() {
  let data;
  try { data = await api("/api/platform/dashboard"); } catch (error) { if (error.status === 401 || error.status === 403) return loginView("platform_owner"); throw error; }
  document.querySelector("#logout-button").classList.remove("hidden");
  app.innerHTML = `<section class="dashboard-shell"><aside class="sidebar"><div class="sidebar-user"><strong>${e(data.user.displayName)}</strong><small>Platform sahibi</small></div><nav><button class="active">İşletmeler</button><button disabled>Sistem sağlığı</button></nav></aside><div class="dashboard-content"><div class="page-head"><div><p class="eyebrow">E-RANDEVUM PLATFORMU</p><h1>İşletme hesapları</h1><p>Sabit aylık abonelik personel sayısından bağımsızdır; tahsilat dışarıdan işaretlenir.</p></div><span class="badge success">${e(data.system.status)}</span></div><div class="status-banner info">${e(data.privacyBoundary)}</div><div class="split-panels"><section class="panel"><div class="table-wrap"><table><thead><tr><th>İşletme</th><th>Alt alan adı</th><th>Aktif personel</th><th>Abonelik</th><th>Bitiş</th></tr></thead><tbody>${data.tenants.map((item) => `<tr><td><strong>${e(item.name)}</strong></td><td>${e(item.slug)}.e-randevu.com</td><td>${item.activeStaffCount}</td><td>${badge(item.subscriptionStatus === "active" ? "confirmed" : "cancelled")}</td><td>${dateTime(item.subscriptionEndsAt)}</td></tr>`).join("")}</tbody></table></div></section><section class="panel"><h2>İşletme oluştur</h2><p class="tiny" style="margin:.4rem 0 1rem">İşletmeler kendileri kayıt olamaz. İlk yönetici şifresini platform sahibi belirler.</p><form id="tenant-form" class="form-grid" style="grid-template-columns:1fr"><label class="field"><span>İşletme adı</span><input name="name" required></label><label class="field"><span>Alt alan adı</span><input name="slug" pattern="[a-z0-9-]{3,40}" required></label><label class="field"><span>Yönetici adı</span><input name="adminName" required></label><label class="field"><span>Yönetici kullanıcı adı</span><input name="adminUsername" value="yonetici" required></label><label class="field"><span>İlk şifre</span><input name="initialPassword" value="Demo123!" required></label><button>Hesabı oluştur</button></form></section></div><section class="panel"><div class="panel-head"><h2>Sistem sınırları</h2></div><div class="calculation-strip"><span>Veri: ${e(data.system.database)}</span><span>Ödeme: ${e(data.system.payment)}</span><span>SMS: ${e(data.system.sms)}</span><span>Push: ${e(data.system.webPush)}</span></div></section></div></section>`;
  document.querySelector("#tenant-form").addEventListener("submit", async (event) => { event.preventDefault(); const body = Object.fromEntries(new FormData(event.currentTarget)); try { await api("/api/platform/tenants", { method: "POST", body: JSON.stringify(body) }); toast("İşletme ve ilk yönetici oluşturuldu"); await renderPlatform(); } catch (error) { toast(error.message, "error"); } });
}

async function routeApp() {
  setActiveNav();
  if (route !== "/platform" && !bootstrap) await loadBootstrap();
  if (route === "/randevu" || route === "/odeme") renderBooking();
  else if (route === "/personel") await renderStaff();
  else if (route === "/yonetici") await renderAdmin();
  else if (route === "/platform") await renderPlatform();
  else renderBooking();
}

async function setupPwa() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstall = event; document.querySelector("#install-button").classList.remove("hidden"); });
  document.querySelector("#install-button").addEventListener("click", async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; document.querySelector("#install-button").classList.add("hidden"); });
  document.querySelector("#push-button").addEventListener("click", async () => {
    if (!("Notification" in window)) return toast("Bu tarayıcı bildirim desteklemiyor", "error");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return toast("Telefon bildirimi izni verilmedi; uygulama içi kutu çalışmaya devam eder", "error");
    const registration = await navigator.serviceWorker.ready; await registration.showNotification("E-Randevum demo bildirimi", { body: "İzin çalışıyor. Uygulama kapalıyken gerçek teslimat için üretim VAPID/Web Push servisi gerekir.", icon: `/favicon.svg?isletme=${tenantSlug}` });
  });
}

function setupWebMcp() {
  const context = document.modelContext; if (!context?.registerTool || route !== "/randevu") return;
  const controller = new AbortController();
  Promise.resolve(context.registerTool({
    name: "randevu_uygunluk_goster", title: "Uygun randevu saatlerini göster",
    description: "Seçili hizmetler ve tarih için görünür E-Randevum ekranında uygun saatleri yükler. Randevu oluşturmaz veya ödeme yapmaz.",
    inputSchema: { type: "object", properties: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, serviceIds: { type: "array", items: { type: "integer" }, minItems: 1 } }, required: ["date", "serviceIds"], additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    async execute(input) {
      state.date = input.date; state.selectedServices = new Set(input.serviceIds); renderBooking(); await loadAvailability();
      return { date: input.date, slotCount: state.slots.length, firstSlots: state.slots.slice(0, 5).map((slot) => slot.startAt) };
    },
  }, { signal: controller.signal })).catch(() => {});
}

document.querySelector("#logout-button").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST", body: "{}" }); document.querySelector("#logout-button").classList.add("hidden"); await routeApp(); });

setupPwa();
routeApp().then(setupWebMcp).catch((error) => { console.error(error); app.innerHTML = `<div class="status-banner danger"><strong>Uygulama açılamadı.</strong><br>${e(error.message)}</div>`; });
