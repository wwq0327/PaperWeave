export const messageOf = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
