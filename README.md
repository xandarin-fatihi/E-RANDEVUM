# E‑Randevum

Çok işletmeli berber, kuaför, manikür ve pedikür randevu SaaS’ının ilk çalışan sürümü.

Bu depo iki ayrı teslimat içerir:

- `server.mjs`, `src/` ve `public/`: Node 24 + SQLite ile çalışan gerçek yerel uygulama. Kalıcı veri, oturum, rol ve işletme izolasyonu, atomik saat tutma, ödeme demo adaptörü, onay, iade, gelmeme ve bildirim iş akışları burada çalışır.
- `docs/`: GitHub Pages için açıkça etiketlenmiş statik arayüz demosu. Pages sunucu/SQLite çalıştırmadığı için burada gerçek oturum, kalıcı rezervasyon veya tahsilat yoktur.

## Yerelde çalıştırma

Gereksinim: Node.js 24 veya üzeri.

```powershell
npm start
```

Ardından:

- Müşteri: <http://127.0.0.1:4173/randevu?isletme=yakupberber>
- Personel: <http://127.0.0.1:4173/personel?isletme=yakupberber>
- Yönetici: <http://127.0.0.1:4173/yonetici?isletme=yakupberber>
- Platform: <http://127.0.0.1:4173/platform>

Windows’ta `E-Randevum-Baslat.cmd` dosyasına çift tıklamak da uygulamayı başlatır.

### Demo hesapları

| Rol | Kullanıcı | Şifre |
|---|---|---|
| Platform sahibi | `platform` | `Platform123!` |
| İşletme yöneticisi | `yonetici` | `Demo123!` |
| Personel | `ahmet`, `elif`, `derya` | `Usta123!` |

Telefon doğrulama demo kodu `123456`’dır. Gerçek SMS gönderilmez.

## Uygulanan temel iş kuralları

- Alt alan adı/tenant çözümü: üretim örneği `yakupberber.e-randevu.com`; yerelde `?isletme=yakupberber`.
- Her çalışan için hizmet yetkinliği, çalışma saatleri ve ayrı kapasite.
- Bir rezervasyondaki tüm hizmetleri tek uygun çalışan tamamlar.
- Takvim bloğu `ceil15(hizmet süreleri + işletmenin 5–10 dk payı)` formülüyle hesaplanır.
- Seçilen aralık sunucuda SQLite `BEGIN IMMEDIATE` işlemiyle 5 dakika tutulur.
- Havuz talebi bütün ekibi kapatmaz; dahili `capacity_staff_id` yalnız bir çalışanlık kapasiteyi korur. İlk uygun kabul atomik olarak kazanır.
- Demo hosted-payment adaptörü kart/PAN/CVV kabul etmez. Tam hizmet bedeli başarılı sayılır; platform komisyonu yoktur.
- Erken müşteri iptalinde tam iade; geç iptalde kapora tutulup kalan iade; gelmeme durumunda iade yoktur.
- İşletme iptali ve onay süresi dolması tam iadedir. Geç ödeme bildirimi ikinci rezervasyon yaratmaz ve tam iade akışına girer.
- İşlem gerektiren “müşteri geldi mi?” bildirimi okunmakla kapanmaz. Çalışan/yönetici kararı, puan düzeltmesi ve audit kaydı tutulur.
- Tamamlanan hizmete 1–5 yıldız ve yorum verilir; yorumları yalnız işletme yöneticisi görür.
- Platform sahibi yalnız işletme/abonelik/sistem durumunu görür; müşteri, yorum ve gelir ayrıntıları endpoint’ine sahip değildir.
- İşletme aboneliği bitince yeni randevu kapanır, mevcut randevular yönetilebilir.

## Doğrulama

```powershell
npm run check
npm test
```

İstek üzerine gerçek rol akışını yeniden çalıştırmak için uygulama açıkken:

```powershell
node scripts/demo-role-flow.mjs
```

Bu senaryo platform sahibiyle örnek işletme açar, aboneliği işaretler, yöneticiyle logo/hizmet/personel oluşturur, iki kapasiteyi aynı saatte dener, havuz randevusunu öder, personelle kabul eder ve müşterinin tam iade iptalini doğrular.

## Güvenlik ve veri

- Şifreler `crypto.scrypt` + rastgele salt ile özetlenir.
- Oturum belirteçlerinin yalnız SHA‑256 özeti SQLite’ta tutulur; tarayıcı çerezi `HttpOnly; SameSite=Lax`’tır.
- Bütün işletme yönetim sorguları oturumdaki `tenant_id` ile sınırlandırılır.
- Para kuruş cinsinden tamsayıdır; hizmet, ücret, süre ve politika randevu anında kaydedilir.
- `data/*.db`, `.env` ve günlükler git’e alınmaz.
- Bu bir ilk sürümdür. İnternete açık üretimde TLS, CSRF/origin sertleştirmesi, rate limiting, merkezi secret yönetimi ve çok instance için PostgreSQL gerekir.

## Gerçek üretim entegrasyonları

Bu depoda canlı entegrasyon varmış gibi davranılmaz. Üretim için ayrıca gerekir:

1. Wildcard DNS/TLS (`*.e-randevu.com`) ve güvenli cookie/domain politikası.
2. Her işletmenin kendi merchant hesabına giden hosted ödeme sağlayıcısı, webhook imza doğrulaması, merchant onboarding ve iade API’si.
3. SMS sağlayıcısı, numara doğrulama oran sınırı ve teslimat takibi.
4. VAPID anahtarları, push abonelik tablosu ve kalıcı teslimat/outbox worker’ı. Web Push izin ister ve teslim garantili değildir.
5. Çok instance yarışları için PostgreSQL transaction/row lock veya aralık kısıtı; SQLite bu tek prosesli yerel demo içindir.
6. KVKK/PCI/hukuk metinleri, saklama süreleri, yedekleme ve olay izleme.

## GitHub Pages notu

GitHub Pages yalnız statik dosya sunar. `docs/` altındaki sayfa ürün deneyimini dolaşmak için bir arayüz demosudur; demo verileri tarayıcı belleğindedir ve hiçbir gerçek kart/SMS/rezervasyon işlemi yapmaz. Gerçek backend’i yayınlamak için Node/SQLite yerine yönetilen sunucu + PostgreSQL veya uyumlu serverless mimari gerekir.
