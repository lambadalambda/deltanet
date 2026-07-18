import { dirname, isAbsolute, resolve } from 'node:path';

export const electronSmokeArguments = (input: {
  appDir: string;
  userData: string;
  marker: string;
}): string[] => [
  `--user-data-dir=${input.userData}`,
  `--headwater-desktop-smoke-marker=${input.marker}`,
  input.appDir,
];

export const electronSmokeEnvironment = (
  environment: NodeJS.ProcessEnv,
  input: { userData: string; marker: string },
): NodeJS.ProcessEnv => ({
  ...environment,
  HEADWATER_DESKTOP_SMOKE_ROOT: input.userData,
  HEADWATER_DESKTOP_SMOKE_MARKER: input.marker,
});

export const validateDesktopSmokePaths = (input: {
  isPackaged: boolean;
  root: string;
  marker: string;
}): Readonly<{ root: string; marker: string }> | null => {
  if (input.isPackaged || !isAbsolute(input.root) || !isAbsolute(input.marker)) return null;
  const root = resolve(input.root);
  const marker = resolve(input.marker);
  return dirname(marker) === root ? { root, marker } : null;
};
