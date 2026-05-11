import * as repo from "./admin.repository";

// ── Professionals ─────────────────────────────────────────────────────────────

export async function listProfessionals() {
  return repo.findAllProfessionals();
}

export async function removeProfessional(id: string) {
  await repo.deleteProfessional(id);
  return { ok: true };
}

export async function setPin(id: string, pin: unknown) {
  const pinStr = String(pin ?? "");
  if (!/^\d{4}$/.test(pinStr)) throw { status: 400, message: "PIN debe ser 4 digitos" };
  const pinHash = await Bun.password.hash(pinStr);
  await repo.updateProfessionalPin(id, pinHash);
  return { ok: true };
}

// ── Reports ───────────────────────────────────────────────────────────────────

export async function listReports() {
  return repo.findAllReports();
}

export async function removeReport(id: string) {
  await repo.deleteReport(id);
  return { ok: true };
}

// ── Reviews ───────────────────────────────────────────────────────────────────

export async function listReviews(reported: string | undefined) {
  return repo.findAllReviews(reported === "true");
}

export async function removeReview(id: string) {
  await repo.deleteReview(id);
  return { ok: true };
}

// ── Stores ────────────────────────────────────────────────────────────────────

export async function listStores() {
  return repo.findAllStores();
}

export async function patchStore(id: string, body: Record<string, unknown>) {
  const data: { isPremium?: boolean; isFounder?: boolean } = {};
  if (typeof body.isPremium === "boolean") data.isPremium = body.isPremium;
  if (typeof body.isFounder === "boolean") data.isFounder = body.isFounder;
  return repo.updateStore(id, data);
}

export async function togglePremium(id: string, isPremium: unknown) {
  const updated = await repo.updateStore(id, { isPremium: !!isPremium });
  return { id: updated.id, isPremium: updated.isPremium };
}

export async function removeStore(id: string) {
  await repo.deleteStore(id);
  return { ok: true };
}
