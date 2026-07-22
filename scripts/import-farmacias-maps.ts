// Uso: bun run api/scripts/import-farmacias-maps.ts
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

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function readCsv(filePath: string, urlIndex: number): { name: string; url: string }[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const rows: { name: string; url: string }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 2) continue;
    if (fields.length <= urlIndex) continue;

    const name = fields[0];
    const url = fields[urlIndex];

    if (name && url) {
      rows.push({ name, url });
    }
  }

  return rows;
}

function removeAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeName(name: string): string {
  return removeAccents(
    name
      .toLowerCase()
      .replace(/^farmacia\s+/i, "")
      .replace(/^farmacia\s+/i, "")
      .replace(/obras sociales[-\s]?perfumeria/i, "")
      .replace(/[-–—]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("🔍 DRY RUN — No se modificará la DB\n");

  console.log("=== Importar Google Maps URLs a Farmacias ===\n");

  // Read CSVs
  // farmacias.csv: Google Maps URL at column 7
  // farmacias-2.csv: Google Maps URL at column 6
  const dataDir = join(import.meta.dir, "data");
  const csv1 = readCsv(join(dataDir, "farmacias.csv"), 7);
  const csv2 = readCsv(join(dataDir, "farmacias-2.csv"), 6);
  const csvEntries = [...csv1, ...csv2];

  console.log(`CSV entries: ${csv1.length} + ${csv2.length} = ${csvEntries.length}\n`);

  // Get all farmacias from DB
  const result = await db.query('SELECT id, nombre FROM "Farmacia" WHERE activo = true ORDER BY nombre');
  const dbFarmacias: { id: string; nombre: string }[] = result.rows;

  // Build normalized lookup, sorted by name length desc so more specific matches win
  const dbNormalized = dbFarmacias
    .map((f) => ({
      ...f,
      norm: normalizeName(f.nombre),
    }))
    .sort((a, b) => b.norm.length - a.norm.length);

  let updated = 0;
  const matchedDbNames: string[] = [];
  const unmatchedCsv: string[] = [];
  const matchedCsvNames: Set<string> = new Set();

  // Manual overrides for names that fuzzy matching can't resolve
  const MANUAL_MAP: Record<string, string> = {
    "barrio c h a p e r o": "BARRIO CHAPERO",
    "fachini": "FACCHINI",
    "bacca": "ANALÍA S. MASAT",
    "picech": "SAN MARTÍN",
    "dolzani": "DULAC",
  };

  for (const csv of csvEntries) {
    const csvNorm = normalizeName(csv.name);
    let match: ((typeof dbNormalized)[0]) | undefined;

    // Try manual map first
    const manualDbName = MANUAL_MAP[csvNorm];
    if (manualDbName) {
      match = dbNormalized.find((d) => d.nombre === manualDbName);
    }

    // Fall back to fuzzy matching
    if (!match) {
      for (const dbEntry of dbNormalized) {
        if (csvNorm.includes(dbEntry.norm) || dbEntry.norm.includes(csvNorm)) {
          match = dbEntry;
          break;
        }
      }
    }

    if (match) {
      if (!dryRun) {
        await db.query('UPDATE "Farmacia" SET "googleMapsUrl" = $1 WHERE id = $2', [
          csv.url,
          match.id,
        ]);
      }
      console.log(`${dryRun ? "🔷" : "✅"} ${match.nombre} → ${csv.url}`);
      matchedDbNames.push(match.nombre);
      matchedCsvNames.add(csv.name);
      updated++;
    } else {
      console.log(`❌ Sin match: ${csv.name}`);
      unmatchedCsv.push(csv.name);
    }
  }

  // DB pharmacies that got NO URL update
  const dbWithoutUrl = dbFarmacias.filter((f) => !matchedDbNames.includes(f.nombre));

  console.log(`\n=== Resumen ===`);
  console.log(`✅ ${updated} farmacias actualizadas`);

  if (unmatchedCsv.length > 0) {
    console.log(`\n❌ Sin match (${unmatchedCsv.length}):`);
    for (const name of unmatchedCsv) {
      console.log(`   ${name}`);
    }
  }

  if (dbWithoutUrl.length > 0) {
    console.log(`\n⚠️ Sin URL (${dbWithoutUrl.length}):`);
    for (const f of dbWithoutUrl) {
      console.log(`   ${f.nombre}`);
    }
  }

  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
