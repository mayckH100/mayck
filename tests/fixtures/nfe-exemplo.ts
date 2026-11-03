/** XML sintético de NF-e (dados fictícios) para testes. */
export function nfeXml(cnpjEmit: string, chave = '35261100000000000000550010000012341000012345') {
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${chave}" versao="4.00">
<ide><cUF>35</cUF><mod>55</mod><serie>1</serie><nNF>1234</nNF><dhEmi>2026-11-01T10:00:00-03:00</dhEmi></ide>
<emit><CNPJ>${cnpjEmit}</CNPJ><xNome>Laticínios Exemplo &amp; Cia LTDA</xNome><xFant>Lat Exemplo</xFant><enderEmit><xLgr>Rua A</xLgr><nro>10</nro><xBairro>Centro</xBairro><xMun>Campinas</xMun><UF>SP</UF><CEP>13000000</CEP></enderEmit><IE>123456789</IE></emit>
<dest><CNPJ>11222333000181</CNPJ></dest>
<det nItem="1"><prod><cProd>LT-CX12</cProd><cEAN>SEM GTIN</cEAN><xProd>LEITE INTEGRAL 1L CX 12</xProd><NCM>04012010</NCM><CFOP>5102</CFOP><uCom>CX</uCom><qCom>2.0000</qCom><vUnCom>60.0000000000</vUnCom><vProd>120.00</vProd><vFrete>6.00</vFrete><vDesc>2.00</vDesc>
<rastro><nLote>abc123</nLote><qLote>1.000</qLote><dFab>2026-10-20</dFab><dVal>2027-01-20</dVal></rastro><rastro><nLote>ABC124</nLote><qLote>1.000</qLote><dFab>2026-10-22</dFab><dVal>2027-02-01</dVal></rastro></prod>
<imposto><ICMS><ICMS10><vICMSST>3.00</vICMSST></ICMS10></ICMS><IPI><IPITrib><vIPI>5.00</vIPI></IPITrib></IPI></imposto></det>
<total><ICMSTot><vNF>132.00</vNF></ICMSTot></total></infNFe></NFe><protNFe><infProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
}
