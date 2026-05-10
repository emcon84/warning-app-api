import { sanitizeText } from "../../shared/sanitize";
import { uploadFileToR2 } from "../../shared/storage";
import { sendPushToAllSubscribers } from "../../shared/push";
import * as repo from "./reports.repository";

const VALID_CATEGORIES = [
  "Alumbrado", "Baches", "Basura", "Inundación", "Ruidos molestos",
  "Seguridad", "Semáforos", "Tránsito", "Vandalismo", "Otro",
] as const;

type ReportCategory = (typeof VALID_CATEGORIES)[number];

// ── Reports ───────────────────────────────────────────────────────────────────

export async function listReports(params: {
  category?: string;
  barrio?: string;
  startDate?: string;
  endDate?: string;
}) {
  return repo.findReports({
    category:  params.category  || undefined,
    barrio:    params.barrio    || undefined,
    startDate: params.startDate ? new Date(params.startDate) : undefined,
    endDate:   params.endDate   ? new Date(params.endDate)   : undefined,
  });
}

export async function getReport(id: string) {
  const report = await repo.findReportById(id);
  if (!report) throw { status: 404, message: "Reporte no encontrado" };
  return report;
}

export async function createReport(formData: FormData) {
  const lat = parseFloat(formData.get("lat") as string);
  const lng = parseFloat(formData.get("lng") as string);
  const rawCategory   = formData.get("category")    as string;
  const rawDesc       = sanitizeText(formData.get("description") as string, 1000);
  const barrio        = (formData.get("barrio")    as string)?.trim();
  const direccion     = (formData.get("direccion") as string)?.trim();

  if (isNaN(lat) || isNaN(lng) || !rawCategory || !rawDesc || !barrio || !direccion) {
    throw { status: 400, message: "Faltan campos requeridos" };
  }

  const category = (VALID_CATEGORIES as readonly string[]).includes(rawCategory)
    ? (rawCategory as ReportCategory)
    : null;
  if (!category) throw { status: 400, message: "Categoría inválida" };

  const isUrgent  = formData.get("isUrgent") === "true";
  const rawFecha  = formData.get("fecha") as string | null;
  const createdAt = rawFecha ? new Date(rawFecha) : new Date();

  const photoPaths: string[] = [];

  const single = formData.get("photo") as File | null;
  if (single && single.size > 0) {
    const url = await uploadFileToR2(single, "report");
    if (url) photoPaths.push(url);
  }

  let i = 0;
  while (true) {
    const file = formData.get(`photo${i}`) as File | null;
    if (!file || file.size === 0) break;
    const url = await uploadFileToR2(file, "report");
    if (url) photoPaths.push(url);
    i++;
  }

  const report = await repo.createReport({
    lat, lng, category,
    description: rawDesc,
    barrio, direccion,
    photo:   photoPaths[0] ?? null,
    photos:  photoPaths,
    isUrgent, createdAt,
  });

  sendPushToAllSubscribers({
    title: `Nuevo Reporte: ${report.category}`,
    body:  `${report.description.substring(0, 100)}${report.description.length > 100 ? "..." : ""}`,
    icon:  "/icon-192x192.png",
    badge: "/icon-192x192.png",
    data:  { reportId: report.id, url: "/" },
  });

  return report;
}

export async function updateReport(id: string, body: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  if (body.lat       !== undefined) data.lat       = Number(body.lat);
  if (body.lng       !== undefined) data.lng       = Number(body.lng);
  if (body.category  !== undefined) data.category  = body.category;
  if (body.description !== undefined) data.description = sanitizeText(body.description as string, 1000);
  if (body.barrio    !== undefined) data.barrio    = body.barrio;
  if (body.direccion !== undefined) data.direccion = body.direccion;
  if (body.photo     !== undefined) data.photo     = body.photo;
  if (body.isUrgent  !== undefined) data.isUrgent  = Boolean(body.isUrgent);

  const report = await repo.updateReport(id, data);
  if (!report) throw { status: 404, message: "Reporte no encontrado" };
  return report;
}

export async function deleteReport(id: string) {
  const deleted = await repo.deleteReport(id);
  if (!deleted) throw { status: 404, message: "Reporte no encontrado" };
  return { message: "Reporte eliminado" };
}

export async function getStats() {
  return repo.getStats();
}
