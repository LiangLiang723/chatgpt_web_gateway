export interface ArchitectureImportRule {
  dir: string;
  forbidden(value: string): boolean;
  message: string;
}

export function architectureImportViolation(
  directory: string,
  imported: string,
): string | undefined;

export const architectureImportRules: ArchitectureImportRule[];
