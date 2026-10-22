import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Wiring only: exercised by running the service.
      exclude: ["src/index.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { lines: 100, functions: 95, branches: 95, statements: 98 },
    },
  },
});
