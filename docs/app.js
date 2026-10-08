const app = document.querySelector("#app");
const services = [
  { id: 1, name: "Saç Kesimi", price: 30000, duration: 30 },
  { id: 2, name: "Sakal Tasarımı", price: 18000, duration: 20 },
  { id: 3, name: "Manikür", price: 42000, duration: 45 },
  { id: 4, name: "Pedikür", price: 52000, duration: 60 },
];
const staff = ["Ahmet Usta", "Elif Uzman", "Derya Bakım"];
const demoAppointments = [
  { time: "10:00", customer: "Selin Yılmaz", service: "Saç Kesimi", staff: "Ahmet Usta", status: "confirmed" },
  { time: "11:15", customer: "Mert Demir", service: "Sakal Tasarımı", staff: "Ortak havuz", status: "pending_approval" },
  { time: "14:00", customer: "Deniz Akın", service: "Manikür", staff: "Elif Uzman", status: "confirmed" },
];
let selected = new Set([1]);
let chosenTime = "10:00";
let installPrompt;

const money = (value) => new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(value / 100);
const statusCopy = { confirmed: "Onaylandı", pending_approval: "Onay bekliyor", cancelled: "İptal" };
function toast(text) { const item = document.createElement("div"); item.className = "toast"; item.textContent = text; document.querySelector("#toast-region").append(item); setTimeout(() => item.remove(), 3500); }

function summary() {
  const picked = services.filter((item) => selected.has(item.id));
  const total = picked.reduce((sum, item) => sum + item.price, 0); const minutes = picked.reduce((sum, item) => sum + item.duration, 0);
  const block = picked.length ? Math.ceil((minutes + 10) / 15) * 15 : 0;
  return `<div class="summary-card"><div class="summary-head"><h3>Demo özeti</h3></div><div class="summary-body"><div class="summary-line"><span>Hizmet</span><strong>${picked.map((item)=>item.name).join(" + ") || "—"}</strong></div><div class="summary-line"><span>Süre + pay</span><strong>${minutes ? `${minutes}+10 → ${block} dk` : "—"}</strong></div><div class="summary-line"><span>Saat</span><strong>${chosenTime}</strong></div><div class="summary-line"><span>Tam ödeme</span><strong>${money(total)}</strong></div><div class="summary-line"><span>Geç iptal kaporası</span><strong>${money(Math.round(total*.3))}</strong></div></div></div><div class="policy-box"><strong>Bu sayfa işlem yapmaz</strong>Butonlar ürün deneyimini gösterir. Kalıcı/atomik iş akışı için depodaki Node + SQLite uygulamasını localhost’ta çalıştırın.</div>`;
}

function renderCustomer() {
  app.innerHTML = `<section class="booking-layout"><div><div class="booking-intro"><p class="eyebrow">YAKUP BERBER &amp; BAKIM</p><h1>Uygun zamanı birkaç adımda ayırın.</h1><p>Hizmet, saat ve çalışan filtrelerinin statik ürün demosu.</p><div class="trust-row"><span class="trust-pill">Tam fiyat görünür</span><span class="trust-pill">%30 geç iptal kaporası</span><span class="trust-pill">5 dk saat tutma</span></div></div><div class="booking-main"><section class="step-card"><div class="step-head"><div class="step-title"><span class="step-number">1</span><div><h2>Hizmetlerinizi seçin</h2><p class="step-status">Birden fazla seçim yapabilirsiniz</p></div></div></div><div class="service-grid">${services.map((item)=>`<label class="service-option ${selected.has(item.id)?"selected":""}"><input type="checkbox" value="${item.id}" ${selected.has(item.id)?"checked":""}><span class="service-copy"><strong>${item.name}</strong><small>${item.duration} dakika</small></span><span class="money">${money(item.price)}</span></label>`).join("")}</div></section><section class="step-card"><div class="step-head"><div class="step-title"><span class="step-number">2</span><div><h2>Saat ve çalışan</h2><p class="step-status">Örnek müsaitlik sonucu</p></div></div></div><div class="filter-grid"><label class="field"><span>Tarih</span><input type="date" value="2026-10-12"></label><label class="field"><span>Çalışan</span><select><option>Fark etmez · ortak havuz</option>${staff.map((item)=>`<option>${item}</option>`).join("")}</select></label></div><div class="calculation-strip"><span>Uygun çalışanların tüm süre boyunca takvimi kontrol edilir</span></div><div class="slot-grid">${["09:00","09:45","10:00","11:15","13:30","14:00","16:15","18:00"].map((slot)=>`<button class="slot ${chosenTime===slot?"selected":""}" data-time="${slot}"><strong>${slot}</strong><small>2 uygun çalışan</small></button>`).join("")}</div></section><section class="step-card"><div class="step-head"><div class="step-title"><span class="step-number">3</span><div><h2>İletişim ve ödeme</h2><p class="step-status">Bu Pages sürümü veri göndermez</p></div></div></div><div class="form-grid"><label class="field"><span>Ad soyad</span><input placeholder="Deniz Yılmaz"></label><label class="field"><span>Telefon</span><input placeholder="05xx xxx xx xx"></label></div><div class="status-banner warning" style="margin-top:.8rem">Gerçek uygulamada SMS doğrulaması ve kart verisini hiç almayan hosted ödeme sağlayıcısı kullanılır.</div><button class="wide" id="demo-book" style="margin-top:.8rem">Demo akışını tamamla</button></section></div></div><aside class="booking-aside" id="summary">${summary()}</aside></section>`;
  app.querySelectorAll('input[type="checkbox"]').forEach((input)=>input.addEventListener("change",()=>{ input.checked?selected.add(Number(input.value)):selected.delete(Number(input.value)); renderCustomer(); }));
  app.querySelectorAll("[data-time]").forEach((button)=>button.addEventListener("click",()=>{ chosenTime=button.dataset.time; renderCustomer(); }));
  document.querySelector("#demo-book").addEventListener("click",()=>toast("Statik demo tamamlandı; gerçek randevu oluşturulmadı."));
}

function renderStaff() {
  app.innerHTML = `<section class="dashboard-shell"><aside class="sidebar"><div class="sidebar-user"><strong>Ahmet Usta</strong><small>Statik personel demosu</small></div><nav><button class="active">Randevular</button><button>Bildirimler (1)</button></nav></aside><div class="dashboard-content"><div class="page-head"><div><p class="eyebrow">PERSONEL AKIŞI</p><h1>Takviminiz</h1><p>Havuz talebini ilk kabul eden çalışan atomik olarak alır.</p></div><span class="badge warning">1 onay bekliyor</span></div><div class="status-banner info">Pages sürümündeki işlemler yalnız görsel demodur; sunucuya yazılmaz.</div><div class="appointment-list">${demoAppointments.map((item,index)=>`<article class="appointment-card"><div class="appointment-time"><strong>${item.time}</strong><small>45 dk blok</small></div><div class="appointment-copy"><h3>${item.customer}</h3><p>${item.service} · ${item.staff}</p></div><div class="appointment-actions">${index===1?'<button data-demo>Kabul et</button>':'<button class="ghost" data-demo>Geldi</button><button data-demo>Tamamlandı</button>'}</div></article>`).join("")}</div><div class="notification action"><div><strong>Müşteri geldi mi?</strong><p>Okumak bu görevi kapatmaz; Geldi veya Gelmedi seçimi gerekir.</p></div><span class="badge warning">İşlem gerekli</span></div></div></section>`;
  app.querySelectorAll("[data-demo]").forEach((button)=>button.addEventListener("click",()=>toast("Arayüz tepkisi gösterildi; Pages verisi değiştirilmedi.")));
}

function renderAdmin() {
  app.innerHTML = `<section class="dashboard-shell"><aside class="sidebar"><div class="sidebar-user"><strong>Yakup Berber &amp; Bakım</strong><small>Yönetici demosu</small></div><nav><button class="active">Özet</button><button>Randevular</button><button>Personel</button><button>Hizmetler</button><button>Ayarlar</button></nav></aside><div class="dashboard-content"><div class="page-head"><div><p class="eyebrow">İŞLETME YÖNETİMİ</p><h1>Bugünün nabzı</h1><p>Gelir, personel müşterisi, hizmet ve randevu listelerinin örnek görünümü.</p></div><span class="badge success">Yeni randevu açık</span></div><div class="metric-grid"><div class="metric"><small>Aktif randevu</small><strong>3</strong><em>onaylı + bekleyen</em></div><div class="metric"><small>Brüt ödeme</small><strong>1.020 ₺</strong><em>3 demo işlem</em></div><div class="metric"><small>İade</small><strong>300 ₺</strong><em>1 erken iptal</em></div><div class="metric"><small>Net tutulan</small><strong>720 ₺</strong><em>işletme hesabı</em></div></div><section class="panel"><div class="panel-head"><h2>Randevular</h2></div><div class="table-wrap"><table><thead><tr><th>Saat</th><th>Müşteri</th><th>Hizmet</th><th>Çalışan</th><th>Durum</th></tr></thead><tbody>${demoAppointments.map((item)=>`<tr><td>${item.time}</td><td>${item.customer}</td><td>${item.service}</td><td>${item.staff}</td><td><span class="badge ${item.status==="confirmed"?"success":"warning"}">${statusCopy[item.status]}</span></td></tr>`).join("")}</tbody></table></div></section><div class="split-panels"><section class="panel"><h2>Marka ayarları</h2><div class="form-grid" style="grid-template-columns:1fr;margin-top:1rem"><label class="field"><span>Uygulama adı</span><input value="E-Randevum"></label><label class="field"><span>Logo seç</span><input type="file" accept="image/png,image/jpeg,image/webp"></label><button data-demo>Demo kaydet</button></div></section><section class="panel"><h2>Yöneticiye özel yorumlar</h2><article class="review-card" style="margin-top:1rem"><span class="stars">★★★★★</span><p>Çok özenli ve tam saatinde başladı.</p><small class="tiny">Selin Yılmaz</small></article></section></div></div></section>`;
  app.querySelectorAll("[data-demo]").forEach((button)=>button.addEventListener("click",()=>toast("Marka kontrolü statik demoda gösterildi; dosya yüklenmedi.")));
}

function renderPlatform() {
  app.innerHTML = `<section class="dashboard-shell"><aside class="sidebar"><div class="sidebar-user"><strong>Platform Sahibi</strong><small>Gizlilik sınırı demosu</small></div><nav><button class="active">İşletmeler</button><button>Sistem sağlığı</button></nav></aside><div class="dashboard-content"><div class="page-head"><div><p class="eyebrow">E-RANDEVUM PLATFORMU</p><h1>İşletme hesapları</h1><p>Sabit abonelik personel sayısından bağımsızdır.</p></div><span class="badge success">Sistem sağlıklı</span></div><div class="status-banner info">Müşteri gizli bilgileri, yorumlar ve işletme gelir ayrıntıları platform görünümünde yer almaz.</div><section class="panel"><div class="table-wrap"><table><thead><tr><th>İşletme</th><th>Alt alan adı</th><th>Personel</th><th>Abonelik</th><th>Bitiş</th></tr></thead><tbody><tr><td>Yakup Berber &amp; Bakım</td><td>yakupberber.e-randevu.com</td><td>3</td><td><span class="badge success">Aktif</span></td><td>8 Ekim 2027</td></tr><tr><td>Atlas Bakım Stüdyosu</td><td>atlasbakim.e-randevu.com</td><td>2</td><td><span class="badge success">Aktif</span></td><td>7 Aralık 2026</td></tr></tbody></table></div></section><section class="panel"><h2>Üretim entegrasyon durumu</h2><div class="calculation-strip"><span>Pages: yalnız statik demo</span><span>Ödeme: sağlayıcı hesabı gerekli</span><span>SMS: sağlayıcı gerekli</span><span>Web Push: VAPID gerekli</span></div></section></div></section>`;
}

function render() {
  const role = (location.hash || "#musteri").slice(1);
  document.querySelectorAll(".topnav a").forEach((link)=>link.toggleAttribute("aria-current", link.hash === `#${role}`));
  ({ musteri: renderCustomer, personel: renderStaff, yonetici: renderAdmin, platform: renderPlatform }[role] || renderCustomer)();
}

window.addEventListener("hashchange", render);
window.addEventListener("beforeinstallprompt", (event)=>{ event.preventDefault(); installPrompt=event; });
document.querySelector("#install-button").addEventListener("click", async()=>{ if (!installPrompt) return toast("Tarayıcı yükleme seçeneğini uygun olduğunda gösterecek."); installPrompt.prompt(); await installPrompt.userChoice; installPrompt=null; });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
render();
