import type { FarmaciaRow } from "./pharmacies.repository";
import * as repo from "./pharmacies.repository";

// ── Turno cache (in-memory, 1h TTL) ──────────────────────────────────────────

type TurnoData = { fecha: string; farmacias: FarmaciaRow[]; raw: string[] };
let turnoCache: { timestamp: number; data: TurnoData } | null = null;

const CACHE_TTL = 3_600_000;

// ── Farmacias ─────────────────────────────────────────────────────────────────

export async function listFarmacias() {
  return repo.findActiveFarmacias();
}

export async function getTurno(): Promise<TurnoData & { error?: string }> {
  const now = Date.now();
  if (turnoCache && now - turnoCache.timestamp < CACHE_TTL) {
    return turnoCache.data;
  }

  try {
    const today    = new Date();
    const tomorrow = new Date(today.getTime() + 86_400_000);

    const pad = (n: number) => String(n).padStart(2, "0");

    const dd   = pad(today.getDate());
    const mm   = pad(today.getMonth() + 1);
    const yyyy = String(today.getFullYear());

    const edd   = pad(tomorrow.getDate());
    const emm   = pad(tomorrow.getMonth() + 1);
    const eyyyy = String(tomorrow.getFullYear());

    const dateStr  = `${dd}/${mm}/${yyyy}`;
    const startStr = `${yyyy}-${mm}-${dd}`;
    const endStr   = `${eyyyy}-${emm}-${edd}`;

    const ajaxUrl = `https://regionnet.com.ar/wp-admin/admin-ajax.php?action=eventorganiser-fullcal&event_category=reconquista&start=${startStr}&end=${endStr}`;

    const events: any[] = await fetch(ajaxUrl, {
      headers: {
        "User-Agent": "warning-app/1.0",
        Referer: "https://regionnet.com.ar/servicios/farmacias/",
        "X-Requested-With": "XMLHttpRequest",
      },
    }).then((r) => r.json());

    const nombresDeturno: string[] = events
      .filter(
        (e: any) =>
          Array.isArray(e.className) &&
          e.className.includes("eo-event-running") &&
          e.className.some((c: string) => c.includes("reconquista"))
      )
      .map((e: any) => (e.title as string).trim().toUpperCase());

    const todas = await repo.findActiveFarmacias();

    const deturno =
      nombresDeturno.length > 0
        ? todas.filter((f) =>
            nombresDeturno.some(
              (n) =>
                f.nombre.toUpperCase().includes(n) ||
                n.includes(f.nombre.toUpperCase())
            )
          )
        : [];

    const data: TurnoData = { fecha: dateStr, farmacias: deturno, raw: nombresDeturno };
    turnoCache = { timestamp: now, data };
    return data;
  } catch {
    return { fecha: "", farmacias: [], raw: [], error: "No se pudo obtener el turno" };
  }
}

export async function updateFarmacia(id: string, body: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  if (body.lat      !== undefined) data.lat      = Number(body.lat);
  if (body.lng      !== undefined) data.lng      = Number(body.lng);
  if (body.direccion !== undefined) data.direccion = String(body.direccion).trim();
  if (body.nombre   !== undefined) data.nombre   = String(body.nombre).trim();
  if (body.telefono !== undefined) data.telefono = body.telefono || null;

  if (!Object.keys(data).length) {
    throw { status: 400, message: "Sin campos a actualizar" };
  }

  const farmacia = await repo.updateFarmacia(id, data);
  if (!farmacia) throw { status: 404, message: "Farmacia no encontrada" };
  return farmacia;
}
