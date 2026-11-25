/**
 * Parse the optional `--action-id` used to double-check an approval card at
 * decision time. Both `--action-id=<id>` and `--action-id <id>` are accepted;
 * an explicitly present flag without a value is an error, never an implicit
 * "skip the check". No secrets are involved.
 */
export function parseApprovalActionId(argv: readonly string[]): string | undefined {
  const flag = '--action-id'
  let found: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === flag) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--action-id needs a value`)
      }
      found = value
      index += 1
      continue
    }
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1)
      if (!value) throw new Error(`--action-id needs a value`)
      found = value
    }
  }
  return found
}
