const defaultProfileArtifactNamePattern =
  /^profile\.[0-9]+(?:\.anonymous)?(?:\.[0-9]+\.[0-9a-f]{16}\.tmp)?$/;

export const defaultProfileArtifactName = (
  startedAt: number,
  anonymous: boolean,
): string => `profile.${startedAt}${anonymous ? ".anonymous" : ""}`;

export const isDefaultProfileArtifactName = (name: string): boolean =>
  defaultProfileArtifactNamePattern.test(name);
