export async function inspectEnvironment(input) {
  return {
    input,
    githubToken: process.env.GITHUB_TOKEN,
    stashbaseApiKey: process.env.STASHBASE_API_KEY ?? null,
    unrelatedCredential: process.env.UNRELATED_PARENT_CREDENTIAL ?? null,
    httpsProxy: process.env.HTTPS_PROXY,
  }
}

export async function listGitHubRepos() {
  const response = await fetch('https://api.github.com/user/repos', {
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
    },
  })
  if (!response.ok) throw new Error(`GitHub request failed with status ${response.status}`)
  return response.json()
}
