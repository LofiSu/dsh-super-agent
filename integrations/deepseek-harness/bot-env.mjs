/** Keep the desktop proposal capability out of Agent subprocess environments. */
export function botEnvironment(source = process.env) {
  const env = { ...source };
  delete env.DSH_BOT_PROPOSAL_TOKEN;
  delete env.DSH_BOT_PROPOSAL_TOKEN_FILE;
  return env;
}
