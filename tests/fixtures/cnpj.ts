/** v1.53.0: respostas sintéticas das fontes públicas de CNPJ (formato real, dados fictícios). */
export const CNPJ_OK = '11222333000181';
export const CNPJ_BAIXADA = '11444777000161';

export const brasilApi = (cnpj = CNPJ_OK, extra: Record<string, unknown> = {}) => ({
  cnpj, razao_social: 'PADARIA EXEMPLO LTDA', nome_fantasia: 'PADARIA PAO BOM', descricao_situacao_cadastral: 'ATIVA',
  data_situacao_cadastral: '2015-03-10', descricao_motivo_situacao_cadastral: 'SEM MOTIVO', data_inicio_atividade: '2015-03-10',
  porte: 'MICRO EMPRESA', natureza_juridica: 'Sociedade Empresária Limitada', descricao_identificador_matriz_filial: 'MATRIZ', capital_social: 50000,
  opcao_pelo_simples: true, opcao_pelo_mei: false, cnae_fiscal: 1091102, cnae_fiscal_descricao: 'Fabricação de produtos de padaria',
  cnaes_secundarios: [{ codigo: 4721102, descricao: 'Padaria e confeitaria com predominância de revenda' }, { codigo: 0, descricao: '' }],
  descricao_tipo_de_logradouro: 'RUA', logradouro: 'DAS FLORES', numero: '100', complemento: 'LOJA 2', bairro: 'CENTRO', municipio: 'CARAPICUIBA', uf: 'SP', cep: '06300000',
  ddd_telefone_1: '11987654321', ddd_telefone_2: '1140028922', email: 'CONTATO@PADARIAEXEMPLO.COM.BR',
  qsa: [
    { nome_socio: 'MARIA DA SILVA EXEMPLO', qualificacao_socio: 'Sócio-Administrador', cnpj_cpf_do_socio: '***123456**', faixa_etaria: 'Entre 41 a 50 anos', data_entrada_sociedade: '2015-03-10', cpf_representante_legal: '***000000**' },
    { nome_socio: 'JOAO EXEMPLO', qualificacao_socio: 'Sócio', cnpj_cpf_do_socio: '***654321**', data_entrada_sociedade: '2018-01-02' },
  ],
  ...extra,
});

export const cnpjWs = (cnpj = CNPJ_OK) => ({
  razao_social: 'PADARIA EXEMPLO LTDA', capital_social: '50000.00', porte: { id: '01', descricao: 'Micro Empresa' }, natureza_juridica: { descricao: 'Sociedade Empresária Limitada' },
  simples: { simples: 'Sim', mei: 'Não' },
  socios: [{ nome: 'MARIA DA SILVA EXEMPLO', cpf_cnpj_socio: '***123456**', qualificacao_socio: { descricao: 'Sócio-Administrador' }, data_entrada: '2015-03-10' }],
  estabelecimento: {
    cnpj, nome_fantasia: 'PADARIA PAO BOM', situacao_cadastral: 'Ativa', data_inicio_atividade: '2015-03-10', tipo: 'Matriz',
    atividade_principal: { id: '1091102', descricao: 'Fabricação de produtos de padaria' }, atividades_secundarias: [],
    tipo_logradouro: 'Rua', logradouro: 'das Flores', numero: '100', bairro: 'Centro', cep: '06300000', cidade: { nome: 'Carapicuíba' }, estado: { sigla: 'SP' },
    ddd1: '11', telefone1: '987654321', email: 'contato@padariaexemplo.com.br',
  },
});
