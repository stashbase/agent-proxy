export function inspectEnvironment(input: { issue: string }): Promise<{
  input: { issue: string }
  githubToken?: string
  stashbaseApiKey: string | null
  unrelatedCredential: string | null
  httpsProxy?: string
}>

export function listGitHubRepos(): Promise<Array<{ full_name: string }>>
