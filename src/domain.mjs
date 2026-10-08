export const ACTIVE_BOOKING_STATUSES = ["held", "pending_approval", "confirmed"];

export function ceilToQuarter(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("Süre pozitif olmalı");
  return Math.ceil(minutes / 15) * 15;
}

export function calculateReservation(services, bufferMinutes = 10, depositRate = 30) {
  const serviceMinutes = services.reduce((sum, item) => sum + Number(item.duration_min), 0);
  const totalPriceKurus = services.reduce((sum, item) => sum + Number(item.price_kurus), 0);
  const reservedMinutes = ceilToQuarter(serviceMinutes + Number(bufferMinutes));
  const depositKurus = Math.round(totalPriceKurus * Number(depositRate) / 100);
  return { serviceMinutes, bufferMinutes: Number(bufferMinutes), reservedMinutes, totalPriceKurus, depositKurus };
}

export function cancellationOutcome({ now, startAt, cutoffHours, totalKurus, depositKurus, actor = "customer" }) {
  if (actor === "business" || actor === "approval_timeout") {
    return { kind: "full_refund", refundKurus: totalKurus, retainedKurus: 0 };
  }
  if (now >= new Date(startAt)) {
    return { kind: "no_show", refundKurus: 0, retainedKurus: totalKurus };
  }
  const cutoff = new Date(new Date(startAt).getTime() - Number(cutoffHours) * 3_600_000);
  if (now < cutoff) return { kind: "free_cancel", refundKurus: totalKurus, retainedKurus: 0 };
  return {
    kind: "late_cancel",
    refundKurus: Math.max(0, totalKurus - depositKurus),
    retainedKurus: Math.min(totalKurus, depositKurus),
  };
}

export function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("90") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+90${digits.slice(1)}`;
  if (digits.length === 10) return `+90${digits}`;
  throw new Error("Geçerli bir Türkiye telefon numarası girin");
}

export function isStrongEnoughPassword(value) {
  const password = String(value || "");
  return password.length >= 8 && /[A-ZÇĞİÖŞÜ]/.test(password) && /[a-zçğıöşü]/.test(password) && /\d/.test(password);
}

export function formatMoney(kurus) {
  return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(Number(kurus) / 100);
}

export function overlaps(startA, endA, startB, endB) {
  return new Date(startA) < new Date(endB) && new Date(endA) > new Date(startB);
}
