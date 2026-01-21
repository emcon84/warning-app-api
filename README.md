# API de Reportes Ciudadanos

API REST desarrollada con Bun y PostgreSQL para gestionar reportes ciudadanos.

## 🚀 Instalación

```bash
# Instalar dependencias
bun install

# Configurar base de datos
cp .env.example .env
# Editar .env con tu configuración de PostgreSQL

# Generar cliente de Prisma
bun run db:generate

# Aplicar migraciones
bun run db:push
```

## 🗄️ Base de Datos

Configura tu PostgreSQL y actualiza el archivo `.env`:

```env
DATABASE_URL="postgresql://usuario:contraseña@localhost:5432/warning_app"
PORT=3001
CORS_ORIGIN="http://localhost:3000"
```

## 📝 Scripts

- `bun run dev` - Iniciar en modo desarrollo con hot reload
- `bun run start` - Iniciar en producción
- `bun run db:generate` - Generar cliente de Prisma
- `bun run db:push` - Sincronizar esquema con BD
- `bun run db:studio` - Abrir Prisma Studio

## 📡 Endpoints

### Reportes

**GET** `/api/reports`

- Obtener todos los reportes
- Query params: `category`, `barrio`, `startDate`, `endDate`

**GET** `/api/reports/:id`

- Obtener un reporte específico

**POST** `/api/reports`

- Crear nuevo reporte
- Body:

```json
{
  "lat": -29.15,
  "lng": -59.65,
  "category": "basura",
  "description": "Basura sin recoger",
  "barrio": "Centro",
  "direccion": "Calle 1 123",
  "photo": "base64...",
  "fecha": "2026-01-21"
}
```

**PUT** `/api/reports/:id`

- Actualizar reporte

**DELETE** `/api/reports/:id`

- Eliminar reporte

### Estadísticas

**GET** `/api/stats`

- Obtener estadísticas generales
- Respuesta:

```json
{
  "total": 100,
  "byCategory": [...],
  "byBarrio": [...],
  "recent": [...]
}
```

## 🔧 Tecnologías

- **Bun** - Runtime y servidor HTTP
- **Prisma** - ORM
- **PostgreSQL** - Base de datos
- **TypeScript** - Lenguaje
# warning-app-api
