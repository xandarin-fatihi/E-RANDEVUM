import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { isStrongEnoughPassword } from "./domain.mjs";

export function hashPassword(password) {
  if (!isStrongEnoughPassword(password)) {
    throw new Error("Şifre en az 8 karakter, büyük/küçük harf ve rakam içermeli");
  }
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export function verifyPassword(password, encoded) {
  try {
    const [algorithm, nText, saltText, expectedText] = String(encoded).split("$");
    if (algorithm !== "scrypt") return false;
    const expected = Buffer.from(expectedText, "base64url");
    const derived = scryptSync(String(password), Buffer.from(saltText, "base64url"), expected.length, {
      N: Number(nText), r: 8, p: 1,
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function newToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function tokenHash(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((pair) => pair.trim()).filter(Boolean).map((pair) => {
    const index = pair.indexOf("=");
    return index === -1 ? [pair, ""] : [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
  }));
}

export function sessionCookie(token, maxAgeSeconds = 28_800) {
  return `er_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie() {
  return "er_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}
