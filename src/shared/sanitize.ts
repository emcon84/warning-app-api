/**
 * Sanitiza texto para prevenir XSS y limitar longitud.
 * Elimina tags HTML y limita a maxLength caracteres.
 */
export function sanitizeText(
  value: unknown,
  maxLength: number
): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, maxLength);
}

/**
 * Genera un slug URL-safe a partir de texto.
 * Normaliza acentos, elimina caracteres especiales.
 */
export function generateSlug(...parts: string[]): string {
  const base = parts
    .join("-")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}
