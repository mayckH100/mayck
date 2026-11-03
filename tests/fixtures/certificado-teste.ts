/** Certificado A1 de teste gerado na hora (autoassinado, sem valor). Nunca usar certificado real em teste. */
import forge from 'node-forge';

export function pfxTeste(cnpj = '12345678000195', senha = 'teste123') {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000); cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const attrs = [{ name: 'commonName', value: `EMPRESA TESTE LTDA:${cnpj}` }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(attrs); cert.setIssuer(attrs); cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, { algorithm: '3des' });
  return { pfxBase64: forge.util.encode64(forge.asn1.toDer(p12).getBytes()), senha };
}
