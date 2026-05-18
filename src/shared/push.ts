import webPush from "web-push";
import { db } from "../../lib/db";
import { prisma } from "../../lib/prisma";

interface PushPayload {
  title: string;
  body: string;
  url?: string;
  icon?: string;
  badge?: string;
  data?: Record<string, unknown>;
}

/**
 * Envía notificaciones push a todos los suscriptores de un comercio.
 * Fire-and-forget: no bloquea la respuesta del endpoint que la llama.
 * Auto-limpia endpoints expirados (410/404).
 */
export async function sendPushToComercioSubscriptors(
  comercioId: string,
  payload: PushPayload
): Promise<void> {
  try {
    const result = await db.query<{
      endpoint: string;
      p256dh: string;
      auth: string;
    }>(
      `SELECT DISTINCT ps.endpoint, ps.p256dh, ps.auth
       FROM "PushSubscription" ps
       INNER JOIN "ComercioSubscripcion" cs ON cs."clerkUserId" = ps."clerkUserId"
       WHERE cs."comercioId" = $1 AND ps.endpoint IS NOT NULL`,
      [comercioId]
    );

    const notification = JSON.stringify(payload);

    for (const row of result.rows) {
      try {
        await webPush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          notification,
          { urgency: "normal", TTL: 86400 }
        );
      } catch (e: any) {
        if (e?.statusCode === 410 || e?.statusCode === 404) {
          await db.query(
            'DELETE FROM "PushSubscription" WHERE endpoint = $1',
            [row.endpoint]
          );
        }
      }
    }
  } catch {
    // Nunca propagar — el push no debe romper el endpoint que lo dispara
  }
}

async function sendToSubs(
  subs: { endpoint: string; p256dh: string; auth: string }[],
  notification: string
): Promise<void> {
  for (const sub of subs) {
    try {
      await webPush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        notification,
        { urgency: "normal", TTL: 86400 }
      );
    } catch (e: any) {
      if (e?.statusCode === 410 || e?.statusCode === 404) {
        await prisma.pushSubscription.delete({ where: { endpoint: sub.endpoint } }).catch(() => {});
      }
    }
  }
}

export async function sendPushToAllSubscribers(payload: PushPayload): Promise<void> {
  try {
    const subs = await prisma.pushSubscription.findMany({
      select: { endpoint: true, p256dh: true, auth: true },
    });

    const notification = JSON.stringify(payload);

    await sendToSubs(subs, notification);
  } catch {
    // Nunca propagar
  }
}

export async function sendPushToUser(clerkUserId: string, payload: PushPayload): Promise<void> {
  try {
    const subs = await prisma.pushSubscription.findMany({
      where: { clerkUserId },
      select: { endpoint: true, p256dh: true, auth: true },
    });
    await sendToSubs(subs, JSON.stringify(payload));
  } catch {
    // Nunca propagar
  }
}

export async function sendPushToClientToken(clientToken: string, payload: PushPayload): Promise<void> {
  try {
    const subs = await prisma.pushSubscription.findMany({
      where: { OR: [{ clientToken }, { clerkUserId: clientToken }] },
      select: { endpoint: true, p256dh: true, auth: true },
    });
    await sendToSubs(subs, JSON.stringify(payload));
  } catch {
    // Nunca propagar
  }
}
