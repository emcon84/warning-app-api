import { uploadFileToR2, generateFilename } from "../../shared/storage";
import { sanitizeText, generateSlug } from "../../shared/sanitize";
import { sendPushToComercioSubscriptors } from "../../shared/push";
import * as repo from "./stores.repository";

// ── Plan limits ───────────────────────────────────────────────────────────────

const PLAN_LIMITS = {
  free:    { aiAnalysis: 2,  aiImages: 0 },
  premium: { aiAnalysis: 20, aiImages: 5 },
  founder: { aiAnalysis: Infinity, aiImages: Infinity },
} as const;

type Plan = keyof typeof PLAN_LIMITS;

function resolvePlan(isPremium: boolean, isFounder: boolean): Plan {
  if (isFounder) return "founder";
  if (isPremium) return "premium";
  return "free";
}

// ── Stores ────────────────────────────────────────────────────────────────────

const SCORE_WEIGHT = { recommendations: 60, founder: 30, premium: 18, media: 10 };

function calcScore(c: { recommendations?: number; isFounder?: boolean; isPremium?: boolean; foto?: string | null; logo?: string | null }) {
  const recs    = Math.min((c.recommendations ?? 0) / 20, 1) * SCORE_WEIGHT.recommendations;
  const founder = c.isFounder ? SCORE_WEIGHT.founder : c.isPremium ? SCORE_WEIGHT.premium : 0;
  const media   = (c.logo || c.foto) ? SCORE_WEIGHT.media : 0;
  return recs + founder + media;
}

export async function listStores(filters: { barrio?: string; rubro?: string }) {
  const list = await repo.findAllStoresPublic(filters);
  return list.sort((a, b) => calcScore(b) - calcScore(a));
}

export async function getStoreBySlug(slug: string) {
  return repo.findStoreBySlug(slug);
}

export async function getMyStore(clerkUserId: string) {
  return repo.findMyStoreByClerkId(clerkUserId);
}

export async function createStore(clerkUserId: string, formData: FormData) {
  const existing = await repo.findStoreByClerkId(clerkUserId);
  if (existing) throw { status: 409, message: "Ya tenés un perfil de comercio creado" };

  const name        = sanitizeText(formData.get("nombre"),     100);
  const category    = sanitizeText(formData.get("rubro"),      100);
  const neighborhood = sanitizeText(formData.get("barrio"),    100);
  const whatsapp    = sanitizeText(formData.get("whatsapp"),   30);
  const phone       = sanitizeText(formData.get("telefono"),   30)  || undefined;
  const address     = sanitizeText(formData.get("direccion"),  200) || undefined;
  const schedule    = sanitizeText(formData.get("horario"),    200) || undefined;
  const description = sanitizeText(formData.get("descripcion"), 500) || undefined;

  if (!name || !category || !neighborhood || !whatsapp) {
    throw { status: 400, message: "Faltan campos obligatorios: nombre, rubro, barrio, whatsapp" };
  }

  const slug  = generateSlug(name, category);
  const photo = await uploadFileToR2(formData.get("photo") as File | null, "comercio");
  const photos: string[] = [];
  for (let i = 0; i < 10; i++) {
    const url = await uploadFileToR2(formData.get(`photo${i}`) as File | null, "comercio");
    if (url) photos.push(url);
  }

  const total    = await repo.countStores();
  const isFounder = total < 20;

  return repo.createStore({
    clerkUserId,
    nombre:      name,
    rubro:       category,
    slug,
    barrio:      neighborhood,
    whatsapp,
    telefono:    phone,
    direccion:   address,
    horario:     schedule,
    descripcion: description,
    isFounder,
    ...(photo  ? { foto: photo }   : {}),
    ...(photos.length ? { fotos: photos } : {}),
  });
}

export async function updateMyStore(clerkUserId: string, formData: FormData) {
  const existing = await repo.findStoreByClerkId(clerkUserId);
  if (!existing) throw { status: 404, message: "No tenés un comercio registrado" };

  const patch: Record<string, unknown> = {};
  const fields: [string, string, number][] = [
    ["nombre", "nombre", 100], ["rubro", "rubro", 100], ["barrio", "barrio", 100],
    ["whatsapp", "whatsapp", 30],
  ];
  for (const [key, field, max] of fields) {
    const v = formData.get(field);
    if (v !== null) patch[key] = sanitizeText(v, max);
  }
  const nullable: [string, number][] = [
    ["telefono", 30], ["direccion", 200], ["horario", 200], ["descripcion", 500],
    ["zonaEnvio", 200], ["costoEnvio", 100],
  ];
  for (const [field, max] of nullable) {
    const v = formData.get(field);
    if (v !== null) patch[field] = sanitizeText(v, max) || null;
  }
  const aceptaEnviosRaw = formData.get("aceptaEnvios");
  if (aceptaEnviosRaw !== null) {
    patch.aceptaEnvios = aceptaEnviosRaw === "true" || aceptaEnviosRaw === "1";
  }

  const photo = await uploadFileToR2(formData.get("photo") as File | null, "comercio");
  if (photo) patch.foto = photo;

  const newPhotos: string[] = [];
  for (let i = 0; i < 10; i++) {
    const url = await uploadFileToR2(formData.get(`photo${i}`) as File | null, "comercio");
    if (url) newPhotos.push(url);
  }
  if (newPhotos.length) patch.fotos = [...existing.fotos, ...newPhotos];

  return repo.updateStoreByClerkId(clerkUserId, patch);
}

export async function deleteGalleryPhoto(clerkUserId: string, url: string) {
  const existing = await repo.findStoreByClerkId(clerkUserId);
  if (!existing) throw { status: 404, message: "No tenés un comercio registrado" };
  const photos = existing.fotos.filter(f => f !== url);
  return repo.updateStoreByClerkId(clerkUserId, { fotos: photos });
}

// ── Recommend ─────────────────────────────────────────────────────────────────

export async function recommendStore(slug: string, ip: string) {
  const store = await repo.findStoreBySlug(slug);
  if (!store) throw { status: 404, message: "No encontrado" };

  const ipBytes = new TextEncoder().encode(ip + store.id);
  const hashBuf = await crypto.subtle.digest("SHA-256", ipBytes);
  const ipHash  = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

  try {
    await repo.createRecommendation(store.id, ipHash);
    const updated = await repo.incrementRecommendation(store.id);
    return { ok: true, count: updated.recommendations };
  } catch (e: any) {
    if (e?.code === "P2002") {
      return { ok: false, already: true, count: (store as any).recommendations ?? 0 };
    }
    throw e;
  }
}

// ── Reviews ───────────────────────────────────────────────────────────────────

export async function getReviews(slug: string) {
  const store = await repo.findStoreBySlug(slug);
  if (!store) throw { status: 404, message: "No encontrado" };
  return repo.findReviewsByStoreId(store.id);
}

export async function submitReview(slug: string, clerkUserId: string, score: number) {
  if (!score || score < 1 || score > 5) throw { status: 400, message: "Score debe ser entre 1 y 5" };
  const store = await repo.findStoreBySlug(slug);
  if (!store) throw { status: 404, message: "No encontrado" };

  const s      = Math.min(5, Math.max(1, Math.round(score * 10) / 10));
  const review = await repo.upsertReview(store.id, clerkUserId, s);
  const agg    = await repo.aggregateReviews(store.id);
  await repo.updateStoreRating(
    store.id,
    Math.round((agg._avg.score ?? 0) * 10) / 10,
    agg._count.score
  );
  return { id: review.id, score: review.score, createdAt: review.createdAt };
}

// ── Offers ────────────────────────────────────────────────────────────────────

export async function createOffer(clerkUserId: string, formData: FormData) {
  const store = await repo.findStoreByClerkId(clerkUserId);
  if (!store) throw { status: 404, message: "No tenés un comercio registrado" };

  const title = sanitizeText(formData.get("titulo"), 150);
  if (!title) throw { status: 400, message: "El título es obligatorio" };

  const photo          = await uploadFileToR2(formData.get("photo") as File | null, "comercio");
  const validaHastaRaw = formData.get("validaHasta") as string | null;
  const precio         = sanitizeText(formData.get("precio"), 50) || undefined;

  const offer = await repo.createOffer({
    comercio:    { connect: { id: store.id } },
    titulo:      title,
    descripcion: sanitizeText(formData.get("descripcion"), 500) || undefined,
    terminos:    sanitizeText(formData.get("terminos"), 1000)    || undefined,
    precio,
    foto:        photo ?? undefined,
    validaHasta: validaHastaRaw ? new Date(validaHastaRaw) : undefined,
  });

  sendPushToComercioSubscriptors(store.id, {
    title: `${store.nombre} publicó una oferta`,
    body:  precio ? `${title} · ${precio}` : title,
    url:   `/comercio/${store.slug}`,
    icon:  store.logo ?? store.foto ?? "/icon-192x192.png",
  });

  return offer;
}

export async function updateOffer(
  clerkUserId: string,
  offerId: string,
  body: FormData | Record<string, unknown>,
  isJson: boolean
) {
  const store = await repo.findStoreByClerkId(clerkUserId);
  if (!store) throw { status: 404, message: "No tenés un comercio registrado" };
  const offer = await repo.findOfferById(offerId);
  if (!offer || offer.comercioId !== store.id) throw { status: 404, message: "Oferta no encontrada" };

  if (isJson) {
    const data = body as Record<string, unknown>;
    return repo.updateOffer(offerId, {
      activa: typeof data.activa === "boolean" ? data.activa : undefined,
    });
  }

  const fd             = body as FormData;
  const title          = sanitizeText(fd.get("titulo"), 150);
  if (!title) throw { status: 400, message: "El título es obligatorio" };

  const clearPhoto     = fd.get("clearPhoto") as string | null;
  const newPhoto       = await uploadFileToR2(fd.get("photo") as File | null, "comercio");
  const photo          = newPhoto ?? (clearPhoto === "1" ? null : undefined);
  const validaHastaRaw = fd.get("validaHasta") as string | null;

  return repo.updateOffer(offerId, {
    titulo:      title,
    descripcion: sanitizeText(fd.get("descripcion"), 500) || null,
    terminos:    sanitizeText(fd.get("terminos"), 1000)    || null,
    precio:      sanitizeText(fd.get("precio"), 50)        || null,
    foto:        photo,
    validaHasta: validaHastaRaw ? new Date(validaHastaRaw) : null,
  });
}

export async function deleteOffer(clerkUserId: string, offerId: string) {
  const store = await repo.findStoreByClerkId(clerkUserId);
  if (!store) throw { status: 404, message: "No tenés un comercio registrado" };
  const offer = await repo.findOfferById(offerId);
  if (!offer || offer.comercioId !== store.id) throw { status: 404, message: "Oferta no encontrada" };
  await repo.deleteOffer(offerId);
  return { ok: true };
}

// ── Products ──────────────────────────────────────────────────────────────────

export async function createProduct(clerkUserId: string, formData: FormData) {
  const store = await repo.findStoreByClerkId(clerkUserId);
  if (!store) throw { status: 404, message: "No tenés un comercio registrado" };

  const name = sanitizeText(formData.get("nombre"), 200);
  if (!name) throw { status: 400, message: "El nombre es obligatorio" };

  const photo    = await uploadFileToR2(formData.get("photo") as File | null, "producto");
  const stockRaw = formData.get("stock") as string | null;

  return repo.createProduct({
    comercio:    { connect: { id: store.id } },
    nombre:      name,
    tipo:        ["producto", "servicio"].includes(formData.get("tipo") as string) ? formData.get("tipo") as string : "producto",
    descripcion: sanitizeText(formData.get("descripcion"), 500) || undefined,
    precio:      sanitizeText(formData.get("precio"), 50)       || undefined,
    foto:        photo ?? undefined,
    stock:       stockRaw ? parseInt(stockRaw) || null : null,
  });
}

export async function updateProduct(clerkUserId: string, productId: string, formData: FormData) {
  const store   = await repo.findStoreByClerkId(clerkUserId);
  if (!store) throw { status: 404, message: "No tenés un comercio registrado" };
  const product = await repo.findProductById(productId);
  if (!product || product.comercioId !== store.id) throw { status: 404, message: "Producto no encontrado" };

  const photo    = await uploadFileToR2(formData.get("photo") as File | null, "producto");
  const stockRaw = formData.get("stock") as string | null;

  return repo.updateProduct(productId, {
    nombre:      sanitizeText(formData.get("nombre"), 200)      || undefined,
    descripcion: sanitizeText(formData.get("descripcion"), 500) || null,
    precio:      sanitizeText(formData.get("precio"), 50)       || null,
    activo:      formData.get("activo") === "false" ? false : true,
    stock:       stockRaw ? parseInt(stockRaw) || null : undefined,
    ...(photo ? { foto: photo } : {}),
  });
}

export async function deleteProduct(clerkUserId: string, productId: string) {
  const store   = await repo.findStoreByClerkId(clerkUserId);
  if (!store) throw { status: 404, message: "No tenés un comercio registrado" };
  const product = await repo.findProductById(productId);
  if (!product || product.comercioId !== store.id) throw { status: 404, message: "Producto no encontrado" };
  await repo.deleteProduct(productId);
  return { ok: true };
}

// ── Follow / Unfollow ─────────────────────────────────────────────────────────

export async function getFollowStatus(slug: string, clerkUserId: string | null) {
  const store = await repo.findStoreBySlug(slug);
  if (!store) throw { status: 404, message: "No encontrado" };
  const count      = await repo.countSubscribers(store.id);
  const subscribed = clerkUserId
    ? !!(await repo.findSubscription(store.id, clerkUserId))
    : false;
  return { subscribed, count };
}

export async function follow(slug: string, clerkUserId: string) {
  const store = await repo.findStoreBySlug(slug);
  if (!store) throw { status: 404, message: "No encontrado" };
  try {
    await repo.createSubscription(store.id, clerkUserId);
  } catch (e: any) {
    if (e?.code !== "P2002") throw e;
  }
  return { ok: true };
}

export async function unfollow(slug: string, clerkUserId: string) {
  const store = await repo.findStoreBySlug(slug);
  if (!store) throw { status: 404, message: "No encontrado" };
  try {
    await repo.deleteSubscription(store.id, clerkUserId);
  } catch { /* already unfollowed */ }
  return { ok: true };
}

// ── Analytics ─────────────────────────────────────────────────────────────────

export async function trackEvent(slug: string, type: string) {
  if (!repo.isAllowedEventType(type)) throw { status: 400, message: "Tipo de evento inválido" };
  const store = await repo.findStoreBySlug(slug);
  if (!store) throw { status: 404, message: "Comercio no encontrado" };
  const date = new Date(new Date().toISOString().slice(0, 10));
  await repo.upsertEventDay(store.id, type, date);
  return { ok: true };
}

const DOW_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

function calcProfileScore(store: Awaited<ReturnType<typeof repo.findMyStoreByClerkId>>) {
  if (!store) return { score: 0, items: [] };
  const items = [
    { label: "Foto de portada",    done: !!store.foto,                                         points: 15 },
    { label: "Logo",               done: !!store.logo,                                         points: 10 },
    { label: "Descripción",        done: !!store.descripcion && store.descripcion.length > 20,  points: 15 },
    { label: "WhatsApp",           done: !!store.whatsapp,                                     points: 10 },
    { label: "1 producto/servicio",done: (store.productos?.length ?? 0) > 0,                   points: 15 },
    { label: "3+ productos",       done: (store.productos?.length ?? 0) >= 3,                  points: 10 },
    { label: "Oferta activa",      done: (store.offers?.filter((o: any) => o.activa).length ?? 0) > 0, points: 10 },
    { label: "Reseñas de clientes",done: (store.ratingCount ?? 0) > 0,                        points: 10 },
    { label: "Galería de fotos",   done: (store.fotos?.length ?? 0) > 0,                       points: 5  },
  ];
  const score = items.filter(i => i.done).reduce((a, i) => a + i.points, 0);
  return { score, items };
}

export async function getAnalytics(clerkUserId: string) {
  const [store, fullStore] = await Promise.all([
    repo.findStoreSlugByClerkId(clerkUserId),
    repo.findMyStoreByClerkId(clerkUserId),
  ]);
  if (!store) throw { status: 404, message: "Comercio no encontrado" };

  const now   = new Date();
  const toStr = (d: Date) => d.toISOString().slice(0, 10);

  const thisMonthStartStr = toStr(new Date(now.getFullYear(), now.getMonth(), 1));
  const lastMonthStartStr = toStr(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const lastMonthEndStr   = toStr(new Date(now.getFullYear(), now.getMonth(), 0));
  const thirtyDaysAgoStr  = toStr(new Date(Date.now() - 30 * 86400_000));

  const events = await repo.findEventsSince(store.id, lastMonthStartStr);
  const thisMonth:   Record<string, number>                   = {};
  const lastMonth:   Record<string, number>                   = {};
  const last30:      Record<string, number>                   = {};
  const dailyLast30: Record<string, Record<string, number>>   = {};
  const dowAccum:    Record<string, number>                   = {};
  const weeklyAccum: Record<string, number>                   = {};

  for (const e of events) {
    const dateStr = String(e.date);
    if (dateStr >= thisMonthStartStr) thisMonth[e.type] = (thisMonth[e.type] ?? 0) + e.count;
    if (dateStr >= lastMonthStartStr && dateStr <= lastMonthEndStr)
      lastMonth[e.type] = (lastMonth[e.type] ?? 0) + e.count;
    if (dateStr >= thirtyDaysAgoStr) {
      last30[e.type] = (last30[e.type] ?? 0) + e.count;
      if (!dailyLast30[dateStr]) dailyLast30[dateStr] = {};
      dailyLast30[dateStr][e.type] = (dailyLast30[dateStr][e.type] ?? 0) + e.count;

      // Day of week
      const dow = DOW_LABELS[new Date(dateStr).getDay()];
      dowAccum[dow] = (dowAccum[dow] ?? 0) + e.count;

      // Weekly (ISO week key = Monday of that week)
      const d = new Date(dateStr);
      const monday = new Date(d);
      monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const weekKey = monday.toISOString().slice(0, 10);
      weeklyAccum[weekKey] = (weeklyAccum[weekKey] ?? 0) + e.count;
    }
  }

  // Build ordered day-of-week array (Mon → Sun)
  const dayOfWeek = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]
    .map(d => ({ day: d, total: dowAccum[d] ?? 0 }));

  // Build sorted weekly array
  const weeklyData = Object.entries(weeklyAccum)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, total]) => ({ week, total }));

  // Conversion rate: whatsapp_clicks / profile_views
  const views   = thisMonth["profile_view"]   ?? 0;
  const clicks  = thisMonth["whatsapp_click"] ?? 0;
  const conversionRate = views > 0 ? Math.round((clicks / views) * 100 * 10) / 10 : 0;

  const profileScore = calcProfileScore(fullStore);

  return { thisMonth, lastMonth, last30, dailyLast30, dayOfWeek, weeklyData, conversionRate, profileScore };
}

export async function getPlan(clerkUserId: string) {
  const store = await repo.findStoreByClerkId(clerkUserId);
  if (!store) throw { status: 404, message: "Comercio no encontrado" };

  const plan   = resolvePlan(store.isPremium, store.isFounder);
  const limits = PLAN_LIMITS[plan];
  const today  = new Date(new Date().toISOString().slice(0, 10));
  const key    = `ai_${store.id}`;

  const usageRow    = await repo.getAiUsageToday(key, today);
  const aiUsedToday = usageRow?.count ?? 0;

  return {
    plan,
    productsLimit:   plan === "free" ? 50 : plan === "premium" ? 100 : null,
    aiAnalysisLimit: limits.aiAnalysis === Infinity ? null : limits.aiAnalysis,
    aiImagesLimit:   limits.aiImages   === Infinity ? null : limits.aiImages,
    aiUsedToday,
  };
}

export async function checkAndIncrementAiUsage(
  clerkUserId: string,
  type: "analysis" | "image"
) {
  const store  = await repo.findStoreByClerkId(clerkUserId);
  if (!store) throw { status: 404, message: "Comercio no encontrado" };

  const plan   = resolvePlan(store.isPremium, store.isFounder);
  const limits = PLAN_LIMITS[plan];
  const limit  = type === "analysis" ? limits.aiAnalysis : limits.aiImages;
  const today  = new Date(new Date().toISOString().slice(0, 10));
  const key    = `ai_${type}_${store.id}`;

  if (limit !== Infinity) {
    const usage = await repo.getAiUsageToday(key, today);
    if ((usage?.count ?? 0) >= limit) {
      throw { status: 429, message: `Límite de IA alcanzado para hoy (plan ${plan}: ${limit}/${type})` };
    }
  }

  await repo.incrementAiUsage(key, today);
  return store;
}

// ── AI Recommendations ────────────────────────────────────────────────────────

export async function generateRecommendations(clerkUserId: string) {
  await checkAndIncrementAiUsage(clerkUserId, "analysis");

  const [analytics, fullStore] = await Promise.all([
    getAnalytics(clerkUserId),
    repo.findMyStoreByClerkId(clerkUserId),
  ]);

  if (!fullStore) throw { status: 404, message: "Comercio no encontrado" };

  const incompleteItems = analytics.profileScore.items
    .filter((i: { done: boolean; label: string; points: number }) => !i.done)
    .map((i: { label: string; points: number }) => `- ${i.label} (+${i.points}pts)`)
    .join("\n") || "- (perfil completo)";

  const views       = analytics.thisMonth["profile_view"]   ?? 0;
  const clicks      = analytics.thisMonth["whatsapp_click"] ?? 0;
  const productViews= analytics.thisMonth["product_view"]   ?? 0;
  const offerViews  = analytics.thisMonth["offer_view"]     ?? 0;
  const bestDay     = [...(analytics.dayOfWeek ?? [])].sort((a, b) => b.total - a.total)[0];
  const dayLabel    = bestDay?.total > 0 ? bestDay.day : "sin datos";

  const prompt = `Sos un consultor de marketing digital para pequeñas y medianas empresas de Argentina.
Analizá los datos reales del siguiente comercio y devolvé EXACTAMENTE 4 recomendaciones concretas y accionables, personalizadas para este comercio específico (rubro ${fullStore.rubro}).

DATOS DEL COMERCIO:
- Nombre: ${fullStore.nombre}
- Rubro: ${fullStore.rubro}
- Barrio: ${fullStore.barrio}
- Score del perfil: ${analytics.profileScore.score}/100

MÉTRICAS DEL MES ACTUAL:
- Visitas al perfil: ${views}
- Clicks en WhatsApp: ${clicks}
- Vistas de productos: ${productViews}
- Vistas de ofertas: ${offerViews}
- Tasa de conversión visitas→WhatsApp: ${analytics.conversionRate}%
- Día de mayor actividad: ${dayLabel}

PRUEBA SOCIAL:
- Recomendaciones: ${fullStore.recommendations ?? 0}
- Reseñas: ${fullStore.ratingCount ?? 0} (promedio: ${fullStore.ratingAvg ?? 0})
- Suscriptores: ${fullStore._count?.subscripciones ?? 0}

ÍTEMS FALTANTES EN EL PERFIL:
${incompleteItems}

Devolvé ÚNICAMENTE un objeto JSON válido con este formato exacto, sin texto adicional:
{
  "recomendaciones": [
    {
      "prioridad": "urgente",
      "titulo": "...",
      "accion": "...",
      "impacto": "..."
    }
  ]
}

Reglas:
- prioridad solo puede ser: "urgente", "recomendado" u "opcional"
- titulo: máximo 8 palabras, directo
- accion: qué hacer exactamente, máximo 25 palabras
- impacto: qué resultado concreto esperar, máximo 20 palabras
- Priorizá según los datos reales: si tiene 0 reseñas, pedirlas es urgente; si la conversión es baja, mejorar descripción es urgente; etc.
- Adaptá las recomendaciones al rubro (${fullStore.rubro})`;

  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 600,
    }),
  });

  if (!groqRes.ok) {
    const errBody = await groqRes.text().catch(() => "");
    console.error("[recommendations] Groq error", groqRes.status, errBody);
    throw { status: 502, message: `Groq ${groqRes.status}: ${errBody.slice(0, 120)}` };
  }

  const groqData = await groqRes.json() as { choices: { message: { content: string } }[] };
  const raw = groqData.choices?.[0]?.message?.content?.trim() ?? "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw { status: 502, message: "No se pudo procesar la respuesta de IA" };

  return JSON.parse(jsonMatch[0]) as { recomendaciones: { prioridad: string; titulo: string; accion: string; impacto: string }[] };
}
