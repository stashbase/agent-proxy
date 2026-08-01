export async function listGitHubRepositories() {
  const response = await fetch('https://api.github.com/user/repos?per_page=5', {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    },
  })

  const body = await response.json()

  return {
    status: response.status,
    repositories: response.ok ? body.map((repository) => repository.full_name) : [],
    error: response.ok ? null : body.message,
  }
}
