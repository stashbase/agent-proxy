import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import forge from 'node-forge'

export type CertificateAuthority = {
  caPath: string
  createLeaf(host: string): { cert: string; key: string }
  cleanup(): Promise<void>
}

/** Creates a disposable CA and per-host leaves. No private material is persisted. */
export async function createCertificateAuthority(): Promise<CertificateAuthority> {
  const pki = forge.pki
  const caKeys = pki.rsa.generateKeyPair(2048)
  const ca = pki.createCertificate()

  ca.publicKey = caKeys.publicKey
  ca.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16))
  ca.validity.notBefore = new Date(Date.now() - 60_000)
  ca.validity.notAfter = new Date(Date.now() + 24 * 60 * 60_000)
  const caName = [{ name: 'commonName', value: 'Stashbase Local Agent Proxy CA' }]
  ca.setSubject(caName)
  ca.setIssuer(caName)
  ca.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ])
  ca.sign(caKeys.privateKey, forge.md.sha256.create())

  const directory = await mkdtemp(join(tmpdir(), 'stashbase-agent-proxy-'))
  const caPath = join(directory, 'ca.pem')

  await writeFile(caPath, pki.certificateToPem(ca), { mode: 0o600 })

  return {
    caPath,
    createLeaf(host) {
      const keys = pki.rsa.generateKeyPair(2048)
      const leaf = pki.createCertificate()

      leaf.publicKey = keys.publicKey
      leaf.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16))
      leaf.validity.notBefore = new Date(Date.now() - 60_000)
      leaf.validity.notAfter = new Date(Date.now() + 24 * 60 * 60_000)
      leaf.setSubject([{ name: 'commonName', value: host }])
      leaf.setIssuer(ca.subject.attributes)
      leaf.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'subjectAltName', altNames: [{ type: 2, value: host }] },
      ])
      leaf.sign(caKeys.privateKey, forge.md.sha256.create())

      return { cert: pki.certificateToPem(leaf), key: pki.privateKeyToPem(keys.privateKey) }
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
