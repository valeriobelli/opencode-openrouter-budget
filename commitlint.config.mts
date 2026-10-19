export default {
  extends: ['@commitlint/config-conventional'],
  // Changesets' automation commits "Version Packages" on release PRs.
  ignores: [(commit) => commit === 'Version Packages'],
}
