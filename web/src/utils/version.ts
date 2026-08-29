export interface MajorMinorVersion {
  major: number
  minor: number
}

export function parseMajorMinor(version: string): MajorMinorVersion | null {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]) }
}

export function isMinorOrMajorUpdate(current: string, latest?: string): boolean {
  if (!latest) return false
  const currentVersion = parseMajorMinor(current)
  const latestVersion = parseMajorMinor(latest)
  if (!currentVersion || !latestVersion) return false
  return currentVersion.major !== latestVersion.major || currentVersion.minor !== latestVersion.minor
}
