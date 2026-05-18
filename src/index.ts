/**
 * Entry point de la nueva API ElysiaJS.
 * Carga el .env antes de cualquier import que use variables de entorno,
 * usando dynamic import para evitar el hoisting de ESM.
 */
import { join } from "path";
import { existsSync, readFileSync } from "fs";

// Cargar .env antes que cualquier módulo que use process.env
const envPath = join(import.meta.dir, "../.env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
  console.log("✅ Variables .env cargadas");
}

// Dynamic import para que Prisma y demás usen el .env ya cargado
const { app } = await import("./app");
import webPush from "web-push";

webPush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:admin@reconquista.gob.ar",
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!,
);

const port = Number(process.env.PORT) || 3001;

app.listen(port, () => {
  console.log(`🚀 API Elysia corriendo en http://localhost:${port}`);
});
