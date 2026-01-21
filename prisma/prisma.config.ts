import { defineConfig } from "prisma/config";

export default defineConfig({
  datasources: {
    db: {
      url:
        process.env.DATABASE_URL ||
        "postgresql://emcon@localhost:5433/warning_app",
    },
  },
});
