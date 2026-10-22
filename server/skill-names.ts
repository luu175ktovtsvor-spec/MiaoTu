// Workspace IDs retain the app's existing character set. The 64-character
// limit matches package installation and Pi's skill-name length limit.
export const SKILL_NAME_MAX_LENGTH = 64
export const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const SKILL_NAME_SCHEMA = {
  type: 'string', minLength: 1, maxLength: SKILL_NAME_MAX_LENGTH, pattern: SKILL_NAME_PATTERN.source,
}

export function skillNameFromFileName(fileName: string) {
  return fileName.replace(/\.md$/i, '').replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+|-+$/g, '').slice(0, SKILL_NAME_MAX_LENGTH) || 'skill'
}
