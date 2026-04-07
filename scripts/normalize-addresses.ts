// Uso: bun run api/scripts/normalize-addresses.ts
// Expande abreviaturas en direcciones de médicos y normaliza capitalización

import { db } from "../lib/db";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

try {
  const envPath = join(import.meta.dir, "../.env");
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    envContent.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        if (key && valueParts.length > 0)
          process.env[key.trim()] = valueParts.join("=").replace(/^["']|["']$/g, "").trim();
      }
    });
  }
} catch {}

// Orden importa: más específicos primero
const REPLACEMENTS: [RegExp, string][] = [
  // Bulevares / Avenidas
  [/\bBV\s+PTE\s+H\.?\s+YRIGOYEN\b/gi,    "Bulevar Presidente Hipólito Yrigoyen"],
  [/\bBV\s+PTE\s+YRIGOYEN\b/gi,            "Bulevar Presidente Hipólito Yrigoyen"],
  [/\bBULEVAR\s+PTE\b/gi,                  "Bulevar Presidente"],
  [/\bAV\b\.?\s*/gi,                        "Avenida "],

  // Almirante Brown (BROWN standalone solo si no viene precedido de "Almirante")
  [/\bALTE\s+G\.?\s+BROWN\b/gi,            "Almirante Guillermo Brown"],
  [/\bALTE\s+BROWN\b/gi,                   "Almirante Guillermo Brown"],
  [/(?<!Almirante Guillermo )\bBROWN\b/gi,  "Almirante Guillermo Brown"],

  // Gobernador
  [/\bGDOR\.?\s+FREYRE\b/gi,               "Gobernador Freyre"],
  [/\bGDOR\.?\s+IRIONDO\b/gi,              "Gobernador Iriondo"],
  [/\bGDOR\.?\s+/gi,                        "Gobernador "],

  // General
  [/\bGRAL\.?\s+MANUEL\s+BELGRANO\b/gi,    "General Manuel Belgrano"],
  [/\bGRAL\.?\s+MANUEL\s+OBLIGADO\b/gi,    "General Manuel Obligado"],
  [/\bGRAL\.?\s+/gi,                        "General "],

  // Bartolomé Mitre
  [/\bB\.?\s+MITRE\b/gi,                   "Bartolomé Mitre"],

  // Hipólito Yrigoyen
  [/\bH\.?\s+YRIGOYEN\b/gi,               "Hipólito Yrigoyen"],
  [/\bHIPOLITO\s+YRIGOYEN\b/gi,           "Hipólito Yrigoyen"],
  [/\bIRIGOYEN\b/gi,                       "Hipólito Yrigoyen"],

  // Jorge Newbery
  [/\bJ\.?\s+NEWBERY\b/gi,                 "Jorge Newbery"],

  // Lucas Funes
  [/\bL\.?\s+FUNES\b/gi,                   "Lucas Funes"],

  // Presidente
  [/\bPTE\.?\s+/gi,                        "Presidente "],

  // Pasaje Ley 1420 (caso especial: "LEY 1420 1420 527" → "Ley 1420 527")
  [/\bLEY\s+1420\s+1420\b/gi,             "Ley 1420"],

  // Normalizar mayúsculas de calles conocidas
  [/\b(SAN\s+MARTIN|SAN\s+MARTÍN)\b/gi,   "San Martín"],
  [/\bSAN\s+LORENZO\b/gi,                  "San Lorenzo"],
  [/\b25\s+DE\s+MAYO\b/gi,                 "25 de Mayo"],
  [/\b9\s+DE\s+JULIO\b/gi,                 "9 de Julio"],
  [/\bBOLIVAR\b/gi,                        "Bolívar"],
  [/\bRIVADAVIA\b/gi,                      "Rivadavia"],
  [/\bSARMIENTO\b/gi,                      "Sarmiento"],
  [/\bMORENo\b/gi,                         "Moreno"],
  [/\bALVEAR\b/gi,                         "Alvear"],
  [/\bITURRASPE\b/gi,                      "Iturraspe"],
  [/\bLUDUEÑA\b/gi,                        "Ludueña"],
  [/\bHABEGGER\b/gi,                       "Habegger"],
  [/\bOLESSIO\b/gi,                        "Olessio"],
  [/\bFREYRE\b/gi,                         "Freyre"],
  [/\bIRIONDO\b/gi,                        "Iriondo"],
  [/\bROCA\b/gi,                           "Roca"],
  [/\bAMENABAR\b/gi,                       "Amenábar"],
  [/\bMITRE\b/gi,                          "Mitre"],
  [/\bNEWBERY\b/gi,                        "Newbery"],
  [/\bPASAJE\b/gi,                         "Pasaje"],
  [/\bCALLE\b/gi,                          "Calle"],
  [/\bPATRICIO\s+DIEZ\b/gi,               "Patricio Díez"],
];

function normalize(dir: string): string {
  let result = dir.trim();
  for (const [pattern, replacement] of REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  // Limpiar espacios dobles
  result = result.replace(/\s{2,}/g, " ").trim();
  return result;
}

async function main() {
  console.log("=== Normalizar direcciones ===\n");

  const { rows } = await db.query(
    'SELECT id, nombre, direccion FROM "Doctor" WHERE direccion IS NOT NULL ORDER BY direccion'
  );

  let changed = 0;
  let unchanged = 0;

  for (const doc of rows) {
    const original = doc.direccion as string;
    const normalized = normalize(original);

    if (normalized !== original) {
      console.log(`✓ ${doc.nombre}`);
      console.log(`  antes:  ${original}`);
      console.log(`  después: ${normalized}\n`);
      await db.query('UPDATE "Doctor" SET direccion = $1 WHERE id = $2', [normalized, doc.id]);
      changed++;
    } else {
      unchanged++;
    }
  }

  console.log(`\n=== Resumen ===`);
  console.log(`Actualizadas: ${changed}`);
  console.log(`Sin cambios:  ${unchanged}`);

  await db.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
