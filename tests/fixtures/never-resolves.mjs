export async function neverResolves() {
  await new Promise(() => {
    setInterval(() => {}, 1_000)
  })
}
