/**
 * Histórico de versões (Novidades) mostrado aos clientes em /versoes e no rodapé do app.
 *
 * REGRA (docs/ATA.md): todo commit com mudança visível para o cliente acrescenta uma entrada
 * NO TOPO desta lista e sobe a versão (1.N.0 → 1.N+1.0; correção pequena sem novidade: 1.N.1).
 * Escreva em português simples, para o cliente final: sem termos técnicos, sem nomes de arquivos,
 * sem dados de clientes, senhas ou chaves. A primeira entrada é a versão atual do app.
 *
 * Só dados e funções puras (sem Node): usado pelo servidor (/api/versao) e pela web (rodapé e página).
 */
export type EntradaChangelog = {
  /** Número da versão, ex. "1.12.0". */
  versao: string;
  /** Data da entrega, dd/mm/aaaa. */
  data: string;
  /** Resumo em uma linha. */
  titulo: string;
  /** O que mudou para o cliente, uma frase por item. */
  itens: string[];
};

export const CHANGELOG: EntradaChangelog[] = [
  {
    versao: '1.51.1',
    data: '24/11/2026',
    titulo: 'MCK Mensagens: “Enviar mesmo assim” direto nas campanhas',
    itens: [
      'Cada campanha que já existe ganhou o botão “⚠ Enviar mesmo assim”, na lista e no detalhe: você assume o risco e ela envia mesmo com o número em nível Risco.',
      'A campanha passa a sair só pelo número principal dela; limites por dia, intervalos e horário continuam valendo, e fica registrado quem confirmou e quando.',
    ],
  },
  {
    versao: '1.51.0',
    data: '24/11/2026',
    titulo: 'MCK Mensagens: escolha por qual número a campanha é enviada',
    itens: [
      'Novo botão "Escolher número de envio" na campanha: você escolhe por qual WhatsApp da empresa ela sai, vendo se cada número está conectado e como está a saúde dele.',
      'Números em risco também aparecem na lista. Ao escolher um deles, o app mostra o aviso e só usa esse número depois de você clicar em "Enviar mesmo assim"; fica registrado quem confirmou e quando.',
      'Com o número escolhido, a campanha não troca de número nem para por causa do risco, mas os limites por hora e por dia, os intervalos e o horário de envio continuam protegendo o número.',
      'Se o número escolhido estiver desconectado, nada é enviado e a campanha mostra o motivo; ela continua sozinha quando ele reconectar.',
      'O modo automático continua sendo o padrão e funciona como antes.',
    ],
  },
  {
    versao: '1.50.1',
    data: '24/11/2026',
    titulo: 'Novo artigo no blog: CRM para WhatsApp',
    itens: [
      'Novo artigo no blog da MCK: "CRM para WhatsApp: como organizar clientes e vendas sem perder nenhuma conversa", com passo a passo para organizar contatos, etiquetas e funil.',
    ],
  },
  {
    versao: '1.50.0',
    data: '24/11/2026',
    titulo: 'MCK ERP volta ao layout das primeiras versões e a entrada de notas por XML ficou mais fácil',
    itens: [
      'O MCK ERP voltou à organização das primeiras versões: as abas no topo (Painel CRM, Venda balcão, Pedidos, Produtos, Estoque, Compras, Financeiro, Fiscal, BI e as demais) e as abas internas dentro de cada tela, como antes.',
      'Tudo o que entrou depois continua lá: o resumo do dia com os indicadores e o "Precisa de atenção" virou a aba Resumo; O que comprar, Avisos de compras e Prazos ficam dentro de Compras; Rastreio de lote, Maquininhas e Alertas têm aba própria; Funcionários e Relatórios seguem no menu lateral. Links salvos continuam abrindo a tela certa.',
      'Entrada por XML: no celular Android o arquivo XML baixado do e-mail ou do WhatsApp agora pode ser escolhido (antes ele aparecia apagado e não dava para tocar).',
      'A importação aceita XML com acentos em qualquer formato (inclusive ISO-8859-1 e UTF-16), arquivo .zip com as notas dentro, NFC-e (cupom de loja) e XML colado direto na tela, com o resultado de cada arquivo à vista.',
      'Quando o arquivo não é a nota completa (PDF do DANFE, resumo da nota, evento de cancelamento, CT-e ou NFS-e), a tela explica o que é e o que enviar.',
      'Ao lançar a nota, o endereço do estoque já vem escolhido quando só existe um, dá para criar o depósito ali mesmo se ainda não houver, e a tela avisa quais itens faltam vincular.',
    ],
  },
  {
    versao: '1.49.0',
    data: '23/11/2026',
    titulo: 'MCK Mensagens: imagem ou PDF na campanha, campanha que se repete, rodízio entre números e público pelas compras do ERP',
    itens: [
      'Agora dá para anexar uma imagem (JPG, PNG ou WEBP) ou um PDF na campanha, com o texto como legenda, e cada versão (A, B, C e D) pode ter o próprio arquivo. A prévia mostra como chega, e o envio de teste também vai com o arquivo.',
      'Campanha que se repete todo dia, toda semana ou todo mês, com data de fim opcional: cada repetição é uma campanha nova para o público atual, sem mandar duas vezes para a mesma pessoa na mesma repetição.',
      'Rodízio entre números: a campanha pode dividir os envios entre vários WhatsApp da empresa. Cada número respeita o próprio limite e a própria saúde, e o mesmo contato recebe sempre pelo mesmo número.',
      'Novo público ao iniciar a campanha: clientes pelas compras no MCK ERP (quanto gastaram, quantas compras fizeram e quando foi a última). A tela mostra quantos contatos atendem antes de começar.',
      'O limite de envios de teste por hora continua valendo mesmo depois de uma atualização do sistema.',
    ],
  },
  {
    versao: '1.48.0',
    data: '23/11/2026',
    titulo: 'MCK Mensagens: versões da mensagem com teste A/B, início agendado, dias da semana, envio de teste e duplicar campanha',
    itens: [
      'Campanhas com até 4 versões da mensagem (A, B, C e D): cada contato recebe sempre uma delas, e a tela da campanha mostra quantas respostas cada versão teve.',
      'Se quiser, o app escolhe a versão vencedora sozinho depois de um número de envios que você define, e o resto da lista passa a receber a que teve mais respostas.',
      'Novas palavras automáticas na mensagem: {saudacao} vira Bom dia, Boa tarde ou Boa noite, {nome_completo} traz o nome inteiro e {Olá|Oi|E aí} troca a palavra para cada contato, deixando os textos menos repetidos.',
      'Agende o início da campanha para o dia e a hora que quiser (até 60 dias à frente) e escolha em quais dias da semana ela envia, por exemplo só de segunda a sexta.',
      'Botão "Enviar teste" na tela da campanha: manda a mensagem para o seu WhatsApp para você ver como chega antes de disparar.',
      'Botão "Duplicar" para reaproveitar uma campanha pronta como rascunho, com o mesmo texto e as mesmas configurações.',
    ],
  },
  {
    versao: '1.47.0',
    data: '23/11/2026',
    titulo: 'Voz do vendedor: áudios gravados que a IA escolhe e voz clonada',
    itens: [
      'Nova tela "Voz do vendedor" (Inteligência artificial › Voz): o vendedor ou o dono grava os áudios mais comuns (boas-vindas, formas de pagamento, entrega, garantia…) pelo próprio app ou envia o arquivo.',
      'Com os áudios gravados ligados, a IA escolhe o áudio certo pela conversa e manda como áudio gravado no WhatsApp, na voz de verdade do vendedor. O que o áudio não cobre, ela escreve logo depois, e o mesmo áudio não se repete na conversa.',
      'Voz clonada: com a autorização por escrito do dono da voz e uma gravação de 1 a 3 minutos, a IA passa a responder com áudio na voz dele. Você ouve uma prévia antes de ativar e pode excluir a voz quando quiser (a gravação e a voz criada são apagadas).',
      'A voz clonada roda no servidor de voz da própria MCK, sem serviço pago e sem enviar a gravação para outras empresas. A gravação fica guardada cifrada. Se o servidor de voz estiver ocupado ou fora do ar, a resposta vai por escrito, sem o cliente ficar esperando.',
    ],
  },
  {
    versao: '1.46.1',
    data: '22/11/2026',
    titulo: 'Campanhas esperam o WhatsApp voltar em vez de falhar',
    itens: [
      'Se o WhatsApp da campanha desconectar, a campanha fica aguardando com o aviso "o WhatsApp desconectou" e ninguém da lista é marcado como falha. Quando o WhatsApp reconectar, ela continua sozinha de onde parou, respeitando o horário, os limites e a proteção do número.',
      'Quando um envio falha por queda de conexão ou instabilidade do WhatsApp, o contato volta para a fila e o envio é tentado de novo (até 3 vezes). Número inválido, sem WhatsApp ou bloqueado continua como falha.',
      'Novo botão na tela da campanha: "Reenviar os que falharam por desconexão". Ele devolve para a fila só quem não recebeu por causa da queda, também nas campanhas antigas.',
      'Ninguém recebe a mesma campanha duas vezes: antes de enviar ou de devolver para a fila, o sistema confere se a mensagem já saiu para aquele contato.',
      'A repescagem e as cadências também esperam o WhatsApp reconectar em vez de gastar tentativas.',
    ],
  },
  {
    versao: '1.46.0',
    data: '22/11/2026',
    titulo: 'Monte sua IA conversando e link para o cliente agendar sozinho',
    itens: [
      'Novo botão "✨ Monte sua IA conversando" em Inteligência artificial (e nos Primeiros passos): cole o link do seu site ou o @ do Instagram, escreva sobre o seu negócio ou envie o PDF de preços ou um áudio explicando. A IA separa produtos, preços, horários, regras e o que nunca deve prometer.',
      'Você confere e corrige tudo numa prévia antes de aplicar. Preço que não aparece no que você mandou vem marcado para conferir. Nada muda na sua conta antes de clicar em "Aplicar", e as suas instruções e documentos atuais não são apagados.',
      'Ao aplicar, a IA ganha a base de conhecimento, as instruções e um fluxo de boas-vindas com menu (com a opção "Falar com um atendente"), além do horário de atendimento com a mensagem de fora do horário. Em poucos minutos o seu WhatsApp já responde sozinho.',
      'Agenda: novo "🔗 Link de agendamento". Cadastre seus serviços com duração e preço, ligue a página e divulgue o link ou o QR code. O cliente escolhe o serviço, o dia e um horário livre, informa nome e WhatsApp e recebe a confirmação no WhatsApp.',
      'O agendamento feito pelo link entra na Agenda, aparece como conversa nova no Inbox e move o cliente para "Reunião agendada" no Kanban. Horários já ocupados (e os do Google Agenda conectado) nunca aparecem, e a página tem proteção contra robôs e excesso de pedidos.',
      'Acabamento: mensagens de erro dos formulários agora em português e com o nome do campo; avisos que abriam a janela do navegador agora aparecem no próprio app; botões de enviar e salvar mostram que estão carregando; no celular, as janelas abrem de baixo para cima e os botões não somem atrás da barra do navegador; telas vazias do Inbox, da Agenda e da Base de conhecimento indicam o próximo passo.',
    ],
  },
  {
    versao: '1.45.0',
    data: '22/11/2026',
    titulo: 'Aquecer número: conversas automáticas entre os seus próprios números do WhatsApp',
    itens: [
      'Em Canais, cada número conectado por QR code tem agora o bloco "🔥 Aquecimento do número", com o botão "🔥 Aquecer número" e o andamento: dia do aquecimento, nível, mensagens de hoje e mensagens recebidas.',
      'Com dois ou mais números seus conectados, eles trocam mensagens casuais entre si, com ida e volta, "digitando…", leitura e às vezes uma reação. Começa com 10 a 15 mensagens no primeiro dia e sobe aos poucos até 60 a 80 por dia, só entre 8h e 21h (horário de Brasília), com intervalos longos e aleatórios.',
      'Você escolhe quais números conversam entre si, a duração (padrão 14 dias) e o horário. Também dá para cadastrar até 5 números seus extras, como o seu celular pessoal, confirmando que são da empresa. O aquecimento nunca envia mensagens para clientes.',
      'Essas mensagens não aparecem no Inbox, não acionam a IA nem os fluxos e não entram nos relatórios. Elas aparecem separadas na Saúde do número. Se o número ficar em Risco ou desconectar, o aquecimento pausa sozinho.',
      'Número com menos de 14 dias e sem aquecimento ganha um aviso no cartão. Os limites de envio em massa saíram do link escondido e agora abrem pelo botão "🛡️ Limites de envio em massa".',
      'Importante: o aquecimento reduz o risco, mas não garante que o WhatsApp não bloqueie o número. Usar o número normalmente (foto, nome, recado e conversas com contatos reais) também ajuda.',
    ],
  },
  {
    versao: '1.44.0',
    data: '22/11/2026',
    titulo: 'Inbox com assistente da IA e cobrança Pix, chat para o seu site e saiba de onde veio cada cliente',
    itens: [
      'Assistente no Inbox: o botão "Resumo" mostra a conversa em poucas linhas, com o próximo passo, e o "Sugerir resposta" escreve um rascunho no campo de mensagem usando a IA da empresa e a base de conhecimento. Você revisa e envia; nada sai sozinho.',
      'Cobrança Pix na conversa: cadastre a chave Pix da empresa uma vez e, no Inbox, clique em "💠 Cobrar Pix", informe o valor e o cliente recebe o QR code e o código "Pix copia e cola". O dinheiro cai direto na sua conta, sem taxa. Depois de conferir no extrato, marque como paga.',
      'Chat para o seu site: em Canais, crie o chat, escolha a cor e a mensagem de boas-vindas e copie o código para o seu site. O visitante conversa por um botão no canto da tela e a mensagem chega no Inbox como "Site", com IA, fluxos, distribuição e horário de atendimento.',
      'Links de origem: em Relatórios › Origem dos leads, crie um link de WhatsApp para cada lugar onde você divulga (bio do Instagram, panfleto, Google). Quando o cliente chama, o sistema registra de onde ele veio. Anúncios de clique para o WhatsApp da API oficial são marcados sozinhos.',
      'Relatórios mostram conversas e clientes novos por origem, e a origem aparece no topo de cada conversa do Inbox.',
      'Campanhas mais seguras: se o número ficar em nível Risco na Saúde do número, a campanha pausa sozinha e avisa. Você escolhe se ela volta sozinha quando o nível melhorar ou se espera você clicar em Retomar.',
    ],
  },
  {
    versao: '1.43.0',
    data: '22/11/2026',
    titulo: 'Campanhas: veja quem respondeu, quem leu e quem não viu, e a repescagem automática fala de novo com quem não respondeu',
    itens: [
      'Na tela de cada campanha, os contatos ficam separados sozinhos: Respondeu, Visualizou e não respondeu, Não visualizou, Não entregue e Saiu (SAIR). Clique num grupo para ver a lista e exporte em planilha (CSV).',
      'Repescagem automática: depois de 2 dias sem resposta (você escolhe), o sistema manda uma nova mensagem para quem não respondeu, no máximo 2 vezes (você escolhe). Vem ligada nas campanhas novas e pode ser ligada nas antigas em Editar.',
      'Quem respondeu qualquer coisa, inclusive "sim", nunca recebe repescagem. Também não recebe quem pediu para sair, já está sendo atendido, está em qualificação ou teve falha no envio.',
      'A IA escreve uma mensagem curta e diferente para cada pessoa, com o nome dela, lembrando a oferta da campanha, sem pressão e sempre com a opção "responda SAIR". Sem IA, vai um texto modelo com variações que você pode editar.',
      'Se a pessoa responder depois da repescagem, a conversa segue para a qualificação normal. Depois da última repescagem sem resposta, o contato fica como "Sem resposta" e não recebe mais nada.',
      'A repescagem respeita o horário da campanha, o limite por dia e a proteção do número. Se o número ficar em nível Risco, ela pausa sozinha e avisa na campanha.',
    ],
  },
  {
    versao: '1.42.0',
    data: '22/11/2026',
    titulo: 'A IA entende áudio e o seu número fica mais protegido contra bloqueio',
    itens: [
      'Quando o cliente manda áudio, a IA ouve, escreve o que foi dito embaixo do áudio no Inbox e responde como se ele tivesse escrito. Fluxos e qualificação de leads também usam esse texto.',
      'Sem custo extra: funciona com o Gemini (plano grátis) ou com a MCK IA; com OpenAI, usa a sua própria chave. Você escolhe a duração máxima do áudio em IA › Voz (padrão 2 minutos).',
      'Se não der para ouvir, fica marcado "[áudio não transcrito]" no Inbox e a IA pede para o cliente escrever. A conversa continua normalmente.',
      'Proteção do número (WhatsApp por QR): campanhas, cadências e automações saem com intervalo aleatório entre uma mensagem e outra e respeitam um limite seguro por hora e por dia. Número novo começa devagar e o limite sobe sozinho nos primeiros dias.',
      'As respostas automáticas mostram "digitando…" antes de chegar, como uma pessoa faria.',
      'Novo painel "Saúde do número" em Canais: mensagens enviadas hoje e na última hora, taxa de resposta, pedidos de saída, bloqueios e desconexões recentes, com nível Bom, Atenção ou Risco e dicas do que fazer.',
    ],
  },
  {
    versao: '1.41.0',
    data: '22/11/2026',
    titulo: 'Inbox mais completo: respostas rápidas, distribuição automática, horário de atendimento, pesquisa de satisfação e mensagens agendadas',
    itens: [
      'Respostas rápidas: cadastre atalhos para as mensagens que você mais manda e, no campo de mensagem, digite / para escolher e inserir. Use {nome} para o primeiro nome do cliente.',
      'Distribuição automática: as conversas que vão para a sua equipe são divididas entre os atendentes, um de cada vez (rodízio) ou para quem está menos ocupado, só entre quem está online e tem acesso àquele WhatsApp.',
      'Horário de atendimento: defina os dias e horários da equipe e, fora deles, o cliente recebe uma mensagem automática (no máximo uma vez a cada tantas horas). Se a IA estiver respondendo, ela continua respondendo normalmente.',
      'Pesquisa de satisfação: ao encerrar a conversa, o cliente pode receber "De 1 a 5, como foi seu atendimento?". A nota média aparece em Relatórios, também por atendente.',
      'Mensagens agendadas: escreva agora e escolha a data e a hora para enviar ao cliente.',
      'Tudo isso fica no Inbox, no botão ⚙️ Atendimento (para Proprietário e Administrador), e vem desligado até você ligar.',
    ],
  },
  {
    versao: '1.40.0',
    data: '22/11/2026',
    titulo: 'Preparação do app MCKBOT para Android',
    itens: ['O MCKBOT ganhou a base para o app oficial de Android, que abre direto no seu painel, com o mesmo login de sempre.'],
  },
  {
    versao: '1.39.0',
    data: '21/11/2026',
    titulo: 'Novo Blog da MCK com guias práticos de WhatsApp, IA e vendas',
    itens: [
      'Blog no site da MCK DESENVOLVIMENTO com 8 guias: chatbot para WhatsApp, como automatizar o WhatsApp Business, IA para responder clientes, mensagens automáticas prontas, como enviar mensagens sem ser bloqueado, funil de vendas, agendamento pelo WhatsApp e ERP para pequenas empresas.',
      'Cada página por segmento, o MCKBOT, o MCK Mensagens e os Planos indicam os artigos relacionados.',
      'Correção na novidade de 03/11: a IA só passa a conversa para uma pessoa da sua equipe quando o cliente pede.',
    ],
  },
  {
    versao: '1.38.0',
    data: '21/11/2026',
    titulo: 'Site da MCK DESENVOLVIMENTO mais claro, rápido e fácil de achar no Google',
    itens: [
      'Página inicial com a proposta direta, botão "Teste grátis 7 dias" e o passo a passo em 3 etapas.',
      'Nova seção de segurança e confiança (CNPJ, proteção dos dados, cópia de segurança diária e LGPD) e perguntas frequentes.',
      'Imagens mais leves e site mais rápido no celular.',
      'Rodapé com WhatsApp, e-mail, Instagram, YouTube e LinkedIn oficiais da MCK.',
    ],
  },
  {
    versao: '1.37.2',
    data: '21/11/2026',
    titulo: 'Alerta diário do WhatsApp mais curto, sem repetir o mesmo produto',
    itens: [
      'O produto que já aparece em "o que comprar" não se repete em "produtos parados".',
      'Sem a linha de resumo no topo e sem repetir valores no "O que fazer hoje".',
    ],
  },
  {
    versao: '1.37.1',
    data: '21/11/2026',
    titulo: 'MCK ERP: seta para voltar tela por tela e Indicadores (BI) logo no Início',
    itens: [
      'Seta ← ao lado do título de cada tela do ERP: volta da seção para a área, do pedido ou cadastro para a lista de onde você veio, e da área para o Início.',
      'O botão voltar do celular também volta tela por tela e fecha a janela aberta antes de sair da tela.',
      'Os Indicadores (BI) aparecem no topo do Início, com um botão para ver todos, e ficam sempre à vista no menu.',
      'Atalhos no Início para Relatório do dia, Avisos de compras e O que comprar.',
    ],
  },
  {
    versao: '1.37.0',
    data: '21/11/2026',
    titulo: 'MCK ERP mais limpo: menu por áreas e telas-resumo com o que precisa de atenção',
    itens: [
      'Menu do ERP em áreas: Início, Vendas, Compras, Estoque, Produção, Financeiro, Fiscal e Configurações. Cada área abre as suas seções (no celular, em botões no topo da tela).',
      'Cada área abre numa tela-resumo com os números principais e atalhos para o que precisa de atenção, como compras atrasadas, aprovações pendentes e estoque abaixo do mínimo.',
      'Menos texto nas telas: as explicações ficam no botão "?" ao lado do título, e ações menos usadas (exportar, importar, regras) ficam no menu "⋯".',
      'Rastreio de lote agora fica em Estoque, e Prazos e avisos fica em Compras. Endereços antigos continuam funcionando, e a tecla F2 segue abrindo a leitura de código.',
      'No celular, as tabelas mostram só as colunas principais; o resto aparece ao abrir o item.',
    ],
  },
  {
    versao: '1.36.0',
    data: '20/11/2026',
    titulo: 'Compras com etapas e prazo: veja na hora se a ordem de compra está no prazo, chega em breve ou atrasou',
    itens: [
      'Ordens de compra com etapas claras: em negociação, aguardando aprovação do gestor, aprovada, emitida, aguardando entrega, aguardando NF, liberação da qualidade (opcional), em conferência, liberada para estoque e em estoque.',
      'Selo de prazo em cada ordem: No prazo, Chega em breve ou Atrasado há N dias, com filtro "Atrasados". A data prevista vem do prazo da cotação (emissão + dias) e pode ser alterada.',
      'Linha do tempo em cada ordem: quem fez, quando, de qual etapa para qual e a observação.',
      'Nova aba 🔔 Avisos em Compras: ordem aguardando aprovação, chegando, atrasada (todo dia enquanto atrasar), NF registrada e liberada para estoque. Também no WhatsApp dos números de alerta do ERP, se você usa o alerta diário.',
      'Opcional: lembrete ao fornecedor antes da data prevista e cobrança quando atrasar, por e-mail ou WhatsApp, com texto que você edita. Vem desligado.',
      'Liberação da qualidade opcional: ligue por produto, por ordem de compra ou para a empresa toda.',
    ],
  },
  {
    versao: '1.35.1',
    data: '20/11/2026',
    titulo: 'Atualizações de segurança',
    itens: [
      'Atualizamos componentes internos do sistema para corrigir falhas de segurança conhecidas.',
      'Nada muda no seu uso: telas e funções continuam iguais.',
    ],
  },
  {
    versao: '1.35.0',
    data: '20/11/2026',
    titulo: 'IA mais inteligente e confiável: aprende com as suas correções, entende melhor a conversa e nunca passa o cliente para a equipe sem ele pedir',
    itens: [
      'Novo botão "👎 IA respondeu mal" em cada resposta da IA no Inbox (Proprietário e Administrador): escreva a resposta certa e ela entra na base de conhecimento na hora. A IA passa a usar essa correção na frente de trechos parecidos. Dá para desfazer em Inteligência artificial › Qualidade.',
      'Nova aba Inteligência artificial › Qualidade: quanto cada recurso de IA usou nos últimos 30 dias (atendimento, SDR, campanhas, ERP, voz), falhas, respostas com valor que não está na sua base e as correções da equipe.',
      'A IA entende perguntas curtas como "e quanto custa?" olhando a pergunta anterior do cliente, e passa a considerar o nome, as etiquetas, a etapa do Kanban e o próximo compromisso do contato para não perguntar de novo o que você já sabe.',
      'Nova opção em Configuração: "Bloquear valores fora da base". Ligada, se a IA citar um preço, desconto ou prazo que não está nas Instruções, na base ou nos Produtos, ela refaz a resposta e, se ainda errar, diz que confirma o valor com a equipe (fica uma nota no Inbox). Vem desligada; mesmo assim esses casos aparecem em Qualidade.',
      'SDR com IA e campanhas: a IA não passa mais a conversa para a equipe sozinha (lead quente, irritado ou com dúvida fora das Instruções). Agora a equipe recebe o aviso com o resumo do lead e a IA continua respondendo. A conversa só vai para uma pessoa quando o cliente pede um atendente — e as transferências que você montou nos fluxos e nas ações da qualificação continuam valendo.',
      'Mais estabilidade: a qualificação do SDR, o follow-up, as campanhas, a aprovação de compra do ERP e a voz agora tentam de novo automaticamente quando a IA fica sobrecarregada por um instante.',
      'MCK ERP: "Localizar pedido" agora fica dentro de Pedidos, e o "📷 Ler código" fica dentro de Venda balcão (PDV). A tecla F2 continua abrindo o leitor em qualquer tela do ERP, e a leitura nas telas de separação, recebimento, inventário e rastreio não mudou.',
    ],
  },
  {
    versao: '1.34.0',
    data: '20/11/2026',
    titulo: 'Venda no balcão, localizar pedido e conferência lendo código de barras ou QR, e etiqueta Zebra impressa direto',
    itens: [
      'Novo botão "📷 Ler código" no topo de todas as telas do MCK ERP (ou a tecla F2): leia com o leitor de código de barras, com a câmera do celular ou digite, e o sistema abre o lugar certo — o pedido, a nota, o lote da etiqueta ou o produto.',
      'Venda balcão (PDV): cada leitura do código de barras ou da etiqueta do lote soma 1 no carrinho. Se a etiqueta tem o lote, a baixa sai daquele lote; se não, o sistema mostra qual lote sai primeiro (o que vence antes ou o mais antigo). Lote vencido, bloqueado ou sem saldo dá aviso na hora.',
      'Depois da venda: imprima o recibo (bobina ou folha) com o QR do pedido. A venda balcão também pode emitir NF-e depois, se o cliente pedir nota.',
      'Nova tela MCK ERP › Localizar pedido: leia o QR do pedido, do recibo ou do romaneio, a etiqueta do lote, o código do produto ou o código de barras da nota (DANFE), ou digite o número do pedido, da nota, o nome do cliente ou o lote. Mostra também todos os pedidos que levaram um lote.',
      'Pedido impresso, romaneio e recibo agora saem com QR e código de barras do pedido, para achar o pedido depois só lendo o papel.',
      'Separação de pedido, conferência do recebimento da nota, entrada de estoque e inventário usam a mesma leitura (leitor, câmera ou digitação), com bipe de acerto e alerta quando o item ou o lote lido está errado.',
      'Impressora Zebra: toque em "Localizar impressora" uma vez (Bluetooth no celular Android, USB no computador ou pelo Zebra Browser Print, inclusive impressora de rede). Depois, "Imprimir na Zebra" manda direto, sem baixar arquivo. O arquivo só é oferecido como último recurso, explicando o motivo.',
      'A leitura pela câmera funciona no Chrome do Android. No iPhone use um leitor de código de barras ou digite o código.',
    ],
  },
  {
    versao: '1.33.0',
    data: '20/11/2026',
    titulo: 'Rastreio completo de lote, etiquetas com código de barras e QR, inventário pelo celular e cadastros editáveis',
    itens: [
      'Produtos: cada produto mostra quantos lotes tem. Toque em "lotes" para ver cada um: lote interno, lote do fornecedor, fornecedor, data de entrada, nota ou pedido de compra, validade, quanto chegou, quanto tem hoje e em que local está.',
      'Estoque ganhou a aba "Saldo por lote". Os saldos antigos que estavam sem lote passaram a aparecer como lote L-INICIAL, com a data da primeira entrada, sem perder nada do histórico.',
      'Nova tela MCK ERP › Rastreio de lote: um só campo aceita o código do produto, o nome, o código de barras, o lote, o lote do fornecedor, o número ou a chave da nota (de compra ou de venda) e o número do pedido.',
      'O rastreio mostra a história inteira do lote: de qual fornecedor e nota veio e quem lançou, mudanças de lugar, reservas, separação, vendas (para qual cliente, pedido e nota), uso na produção, baixas, inventários e devoluções. Mostra onde está cada parte do saldo hoje e para onde foi o que saiu.',
      'Para recall: a partir de um lote você vê todos os clientes que receberam, inclusive dentro de um produto que você fabricou. E de um pedido ou produto pronto você chega aos lotes de origem e ao fornecedor. Dá para baixar em planilha ou imprimir.',
      'Etiqueta do lote gerada pelo sistema, com código de barras e QR: nome da empresa, código do produto, lote, data de fabricação e validade. Logo depois de uma entrada (manual ou pela nota) aparece "Gerar etiqueta e imprimir", já com a quantidade sugerida, e abre o PDF pronto para impressora de etiqueta ou folha A4. Dá para reimprimir a qualquer hora.',
      'Inventário pelo celular: leia o código de barras do produto com a câmera ou com um leitor (cada leitura conta 1) ou digite a quantidade. A contagem fica no lote e no local certos. A etiqueta do lote também é aceita.',
      'Ao encerrar a contagem sai o relatório Físico x Sistema por produto, lote e local, com a diferença em quantidade e em reais, sobras, faltas e o valor final. Se houver diferença, o proprietário recebe um aviso no app e no WhatsApp.',
      'O estoque só é ajustado depois que o proprietário aprova com a senha dele e informa o motivo. A correção manual de saldo de um lote segue a mesma regra e mostra antes, depois e o valor.',
      'Devolução de venda pode devolver os produtos ao estoque, no mesmo lote e local de onde saíram.',
      'Cadastros completos para editar: clientes e fornecedores com inscrição municipal, complemento, código do município, contatos (incluir, editar e excluir), condição de pagamento e tabela de preço padrão do cliente e prazo de entrega do fornecedor. Produtos ganharam o campo descrição.',
      'Campos que não podem mais mudar aparecem com cadeado e o motivo: o CPF/CNPJ que já saiu em nota fiscal, o código do produto que já saiu em nota e a unidade do produto que já tem estoque. Limite de crédito e bloqueio do cliente só o proprietário ou o administrador mudam. Toda alteração fica registrada com quem mudou e o que mudou.',
    ],
  },
  {
    versao: '1.32.0',
    data: '20/11/2026',
    titulo: 'Compras: tela "O que comprar" e produtos comprados em pacote, caixa ou rolo',
    itens: [
      'Nova tela Compras › O que comprar: mostra só os produtos zerados ou abaixo do estoque mínimo, os que já acabaram primeiro e depois os que vão acabar antes.',
      'Para cada produto: quanto tem hoje, o mínimo, quanto vende em média, quantos dias o estoque dura, quanto comprar (você pode mudar), o custo por unidade e o total. Os produtos ficam separados por fornecedor, com subtotal, e o total geral aparece no rodapé.',
      'A quantidade sugerida vem das vendas e baixas dos últimos 30 dias (ou 90 dias, quando vende pouco), para durar 30 dias mais o prazo do fornecedor. Nunca fica abaixo do necessário para voltar ao mínimo e já desconta o que você pediu e ainda não chegou. Cada linha diz o porquê, por exemplo "vende ~2 por dia, dura 3 dias".',
      'Botão "Gerar pedido de compra": cria um pedido em rascunho para cada fornecedor com as quantidades da tela. Produto sem fornecedor vira uma solicitação para cotar. Nada é enviado ao fornecedor sem você.',
      'Unidade de compra no cadastro do produto: por exemplo, o estoque é contado em peças e o fornecedor vende em pacote com 10 peças. O sistema faz a conta (5 pacotes = 50 peças) e mostra o preço do pacote e da peça.',
      'Na entrada de estoque e no pedido de compra você pode digitar em pacotes, caixas ou rolos; o estoque continua guardado em peças, quilos ou metros. Quilo, metro e litro aceitam números quebrados (ex.: 2,5 kg).',
      'O alerta diário do WhatsApp usa a mesma conta da tela e mostra a compra em embalagens, por exemplo "6 pacotes (60 peças)", com o preço do pacote e da peça.',
      'A unidade do produto é escolhida só pela lista. A planilha de produtos ganhou as colunas "Unidade de compra" e "Quantidade por embalagem".',
    ],
  },
  {
    versao: '1.31.0',
    data: '20/11/2026',
    titulo: 'Alerta do ERP mais fácil de entender, lote e código do produto automáticos',
    itens: [
      'O alerta diário do WhatsApp ficou mais claro: cada produto com estoque baixo mostra, uma informação por linha, quanto tem hoje, o estoque mínimo, quanto comprar, o preço por unidade, o total da compra e o fornecedor.',
      'A quantidade sugerida vem com o motivo em palavras simples, por exemplo "para voltar ao estoque mínimo" ou "para ficar com estoque para 30 dias de vendas".',
      'As quantidades aparecem com a unidade por extenso (ex.: 15 unidades, 3 caixas) e os valores em negrito. Os números não ficam mais sublinhados no WhatsApp como se fossem telefone.',
      'Produtos parados agora mostram o "dinheiro parado no estoque", pelo preço de custo. Contas, validade, caixa, alterações e a conversa de aprovação de compra também ficaram com rótulos mais claros.',
      'Lote interno automático: toda entrada de estoque (manual, nota fiscal de entrada ou produção) ganha um número de lote do sistema, por exemplo L2611-0001, sem repetir. O lote do fabricante pode ser digitado ou vem da nota e aparece junto no estoque, nas etiquetas e no alerta de validade.',
      'Código do produto automático: produto novo sem código recebe o próximo da sequência da sua empresa (ex.: MCK0002), também no cadastro pela nota e na planilha. Os códigos que você já tem não mudam.',
      'Unidade de medida escolhida numa lista (Unidade, Caixa, Quilo, Litro...). Número sozinho não é mais aceito como unidade.',
      'Na lista de produtos, cada produto tem os botões Editar e Excluir. Produto que já teve estoque, venda, compra, lote ou nota não é apagado: ele é arquivado, para não perder o histórico. Só o proprietário ou um administrador pode excluir.',
      'Produto perecível (que controla validade) pede a data de validade na entrada de estoque e mostra a validade dos lotes no cadastro. Produto sem esse controle não mostra o campo.',
    ],
  },
  {
    versao: '1.30.0',
    data: '19/11/2026',
    titulo: 'Alerta diário do ERP no WhatsApp mais completo, com compra aprovada por resposta',
    itens: [
      'O alerta diário chega mais organizado: nome da empresa e data no topo, um resumo do dia, seções numeradas, totais e, no fim, uma lista de ações sugeridas. Se ficar longo, vem em mais de uma mensagem.',
      'Estoque baixo: mostra o saldo, o mínimo, quanto falta, o consumo médio dos últimos 30 dias e quanto comprar, com o último fornecedor e o último custo.',
      'Compra aprovada pelo WhatsApp: os itens com estoque baixo vêm numerados com um código. Responda APROVADO para gerar o pedido de compra de todos ou APROVADO 1,3 para só alguns. O pedido fica em rascunho no ERP, separado por fornecedor, e nada é enviado ao fornecedor sem você.',
      'Item sem fornecedor cadastrado: o sistema pergunta se você tem preferência. Responda com o nome do fornecedor ou NÃO.',
      'Validade: lotes vencidos e que vencem nos próximos dias (30 por padrão), com quantidade e valor.',
      'Produtos parados: há quantos dias estão sem venda, a quantidade e o valor parado no estoque.',
      'Caixa de ontem: abertura, vendas por forma de pagamento, retiradas e reforços, diferença no fechamento e quem fez cada coisa.',
      'Alterações de ontem: mudanças de preço e de custo e ajustes manuais de estoque, com quem fez e a hora.',
      'Em ERP › Alertas você liga ou desliga cada parte, escolhe os dias de validade e de produto parado e vê as compras aprovadas pelo WhatsApp.',
    ],
  },
  {
    versao: '1.29.0',
    data: '13/11/2026',
    titulo: 'Contas a pagar e a receber mais fáceis, com parcelas automáticas',
    itens: [
      'Para parcelar, basta informar o valor total, a quantidade de parcelas e o 1º vencimento: o sistema calcula o valor e a data de cada parcela, todo mês no mesmo dia (se o dia não existir no mês, usa o último dia).',
      'Antes de salvar aparece a lista das parcelas, e dá para ajustar o valor ou a data de qualquer uma. Se a soma ficar diferente do valor total, a tela avisa e oferece usar a nova soma como total ou refazer as parcelas.',
      'Também dá para repetir a cada X dias, em vez de todo mês.',
      'Crie categorias e subcategorias direto na tela da conta, pela opção "+ Nova categoria" ou "+ Nova subcategoria".',
      'Nas contas a pagar, crie seus próprios tipos de conta (como Condomínio ou Contador) pela opção "+ Novo tipo de conta".',
      'Novo botão Categorias no Financeiro para renomear, desativar ou excluir categorias, subcategorias e tipos de conta. O que já foi usado em alguma conta é desativado em vez de apagado, para o histórico continuar certo.',
      'O exemplo do campo Descrição agora combina com o tipo de conta escolhido.',
      'Tela ajustada para ficar mais confortável no celular.',
    ],
  },
  {
    versao: '1.28.0',
    data: '13/11/2026',
    titulo: 'PDV com maquininha de cartão (Mercado Pago Point)',
    itens: [
      'Na venda balcão, ao escolher Cartão, a cobrança vai direto para a sua maquininha Mercado Pago Point, com crédito à vista, parcelado ou débito.',
      'A tela mostra "aguardando pagamento na maquininha" e a venda só é registrada, com baixa no estoque e entrada no caixa, quando o pagamento é aprovado. Pagamento recusado, cancelado ou expirado não gera venda.',
      'Dá para cancelar a cobrança pelo PDV enquanto o cliente ainda não pagou.',
      'Nova tela Maquininhas no ERP: cole a chave de acesso (credencial de produção) da sua conta do Mercado Pago, busque as maquininhas, ative o modo PDV e escolha a do caixa. A chave fica guardada de forma cifrada.',
      'Stone, PagBank e Cielo aparecem como "em breve". Sem maquininha configurada, o cartão continua sendo lançado manualmente, como antes.',
    ],
  },
  {
    versao: '1.27.3',
    data: '12/11/2026',
    titulo: 'Respostas em áudio mais inteligentes',
    itens: [
      'Quando o cliente pede áudio, a IA responde em áudio mesmo quando o assunto é longo: ela fala de forma mais direta e, se precisar, manda em mais de uma nota de voz.',
      'A IA não escreve mais marcações como "[enviado como áudio]" nas respostas.',
    ],
  },
  {
    versao: '1.27.2',
    data: '12/11/2026',
    titulo: 'Sem limite também no áudio',
    itens: [
      'Com "Usar limite de uso da IA" desligado, a IA também ouve e responde áudios sem limite.',
    ],
  },
  {
    versao: '1.27.1',
    data: '12/11/2026',
    titulo: 'IA sem limite de uso, se você quiser',
    itens: [
      'Na configuração da IA, a opção "Usar limite de uso da IA" pode ser desligada. Desligada, a IA responde todas as mensagens, sem limite por dia ou por mês.',
    ],
  },
  {
    versao: '1.27.0',
    data: '08/11/2026',
    titulo: 'Plano Completo com preço de entrada para empresas novas',
    itens: [
      'O Plano Completo (MCK ERP + MCKBOT + MCK Mensagens) custa R$ 100 por mês ou R$ 1.000 por ano.',
      'Empresa nova, que ainda não assinou nenhum plano, paga R$ 58 por mês nos 2 primeiros meses do Plano Completo mensal. Depois, o valor normal de R$ 100 por mês.',
      'A promoção aparece no site, na vitrine de planos e na tela Plano, com o preço promocional e o valor que vem depois.',
      'O plano anual não tem a promoção, e cupom de desconto não soma com ela: vale sempre o menor preço.',
      'MCKBOT (R$ 22 por mês) e MCK Mensagens (R$ 15 por mês) continuam com os mesmos preços.',
    ],
  },
  {
    versao: '1.26.0',
    data: '08/11/2026',
    titulo: 'SDR com IA conversa como gente: IA conversacional avançada',
    itens: [
      'Nova opção na aba Inteligência do SDR: "IA conversacional avançada". Vale para os leads do SDR e para quem responde às suas campanhas do MCK Mensagens; o atendimento comum continua igual.',
      'A IA lê os dados do lead (nome, empresa, dados da Receita pelo CNPJ, etapa, respostas já dadas, objeções e a campanha de onde ele veio), as suas Instruções e a conversa inteira, e nunca pergunta de novo o que o lead já respondeu.',
      'Jeito de WhatsApp: mensagens curtas, uma pergunta por vez, no tom do lead, sem frases de robô e sem emojis se a sua empresa não usa.',
      'Antes de responder, a IA entende o que o lead quer e escolhe o próximo passo (qualificar, tratar uma objeção, marcar conversa ou passar ao vendedor), seguindo o método escolhido: Padrão, BANT ou SPIN.',
      'Cada resposta é conferida antes de sair: nada de preço, cobertura ou prazo fora das suas Instruções e nenhum dado sensível. Se a IA não tiver a informação, ela diz que confirma com o especialista e a sua equipe recebe a tarefa.',
      'Lead quente, pedido para falar com uma pessoa, lead irritado ou dúvida fora do que você ensinou: a IA para e passa ao vendedor, que recebe o aviso com o resumo do lead.',
      'Quem já usa o SDR não tem nenhuma mudança nas mensagens até ligar a opção. A conferência pode usar uma resposta a mais da IA e é pulada quando o seu limite diário está no fim.',
    ],
  },
  {
    versao: '1.25.1',
    data: '08/11/2026',
    titulo: 'IA informa os preços certos dos planos',
    itens: [
      'Corrigido: a IA da MCK podia informar o preço dos planos multiplicado por 100 (ex.: R$ 2.200 em vez de R$ 22). Agora ela usa exatamente os valores da página de planos.',
    ],
  },
  {
    versao: '1.25.0',
    data: '08/11/2026',
    titulo: 'Caixa no PDV e planos atualizados',
    itens: [
      'Os planos agora mostram, no site, no cadastro e na tela de assinatura, o nome, a descrição e o que está incluso sempre atualizados pela MCK.',
      'Um plano que saiu de venda deixa de aparecer para novos clientes. Quem já assina continua com tudo o que tem hoje e pode renovar normalmente no mesmo plano.',
      'O acesso ao MCK ERP e à consulta de estoque pela IA segue o que o seu plano inclui. Seus dados continuam guardados e podem ser baixados a qualquer momento.',
      'Caixa do PDV: a venda balcão agora exige caixa aberto, com sangria, suprimento e fechamento com valor contado e diferença.',
      'Voz da IA: a IA sabe que pode responder por áudio e segue, em cada conversa, se o cliente prefere áudio ou texto.',
    ],
  },
  {
    versao: '1.24.0',
    data: '08/11/2026',
    titulo: 'A IA pode consultar o estoque do MCK ERP',
    itens: [
      'Nova opção em Produtos: "De onde a IA consulta os produtos". Escolha "Somente Produtos cadastrados" (como sempre foi), "ERP da MCK (saldo em tempo real)" ou "Os dois".',
      'Com o ERP, a IA responde com o estoque de verdade, já descontando o que está reservado para pedidos e o que está em quarentena, e com o preço cadastrado no produto do ERP.',
      'Em "Os dois", a descrição, a promoção e o link vêm dos Produtos cadastrados e o estoque vem do ERP. Os produtos se ligam pelo código (SKU) citado no produto ou pelo mesmo nome.',
      'Por padrão a IA diz só "disponível", "poucas unidades", "sem estoque" ou "sob encomenda". Se preferir, ligue "Mostrar a quantidade exata" e escolha de qual depósito vem o saldo.',
      'A IA nunca informa custo, fornecedor ou outros dados internos. Se o ERP não responder, ela usa os Produtos cadastrados e continua atendendo.',
      'Use o "Testar" para ver exatamente o que a IA vai receber antes de salvar. A consulta ao ERP faz parte do Plano Completo; quem já usa a IA continua igual até mudar a opção.',
    ],
  },
  {
    versao: '1.23.0',
    data: '07/11/2026',
    titulo: 'A IA agora ouve e responde com áudio no WhatsApp',
    itens: [
      'Quando o cliente manda um áudio, a IA ouve, entende e responde ao que foi dito, usando seus produtos, a base de conhecimento, o SDR e os fluxos, como se ele tivesse escrito. A transcrição aparece no Inbox embaixo do áudio.',
      'A IA também pode responder com nota de voz, com voz natural de atendente brasileiro. Por padrão ela espelha o cliente: áudio responde com áudio e texto com texto. Também dá para escolher "sempre em áudio" ou "nunca em áudio".',
      'Você escolhe o motor da voz: Google Gemini (grátis), OpenAI ou ElevenLabs (a voz mais humana, com a sua própria chave). Escolha a voz feminina ou masculina, o jeito de falar e ouça a prévia antes de salvar.',
      'Links, preços e listas vão por escrito logo depois do áudio. Respostas longas continuam em texto, e se o áudio do cliente não puder ser ouvido a IA pede, com educação, para ele escrever.',
      'No WhatsApp pelo QR code o cliente vê "gravando áudio..." antes da resposta. Conversas com atendente humano não recebem resposta da IA, nem em áudio.',
      'Para ligar: Inteligência artificial › Configuração › Voz. Cada áudio ouvido ou gerado conta no limite de uso da IA.',
    ],
  },
  {
    versao: '1.22.0',
    data: '07/11/2026',
    titulo: 'SDR com IA reconhece respostas automáticas',
    itens: [
      'Quando o lead tem resposta automática ligada (saudação ou ausência do WhatsApp Business, "obrigado pelo contato, retornaremos em breve", horário de atendimento, menus "digite 1 para...", "estou dirigindo", Não Perturbe, férias ou "fora do escritório" no e-mail), isso não conta mais como resposta.',
      'A IA não responde a essas mensagens (nada de robô conversando com robô), o lead não é qualificado nem muda de etapa e a cadência segue normalmente, esperando a resposta de uma pessoa.',
      'A mensagem continua no Inbox e no histórico do lead com o selo "Resposta automática" e o motivo; a aba Relatórios mostra quantas foram ignoradas.',
      'Quem responde de verdade, mesmo ocupado ("estou em reunião, mas tenho interesse, me manda o valor"), continua sendo atendido normalmente.',
      'Já vem ligado para todas as empresas. Na aba Inteligência você pode cadastrar frases próprias, escolher pausar a cadência por algumas horas ao receber uma resposta automática ou desligar o recurso.',
    ],
  },
  {
    versao: '1.21.0',
    data: '07/11/2026',
    titulo: 'SDR com IA mais inteligente: aba Inteligência',
    itens: [
      'Escolha o método de qualificação: o seu (perguntas próprias), BANT ou SPIN. Em cada lead você vê por que a pontuação é essa: o que puxou para cima, o que puxou para baixo, o que falta saber e o próximo passo sugerido.',
      'Biblioteca de objeções ("está caro", "já tenho fornecedor", "agora não", "manda por e-mail"...) com respostas que você edita; quando ligada, a IA usa as suas orientações e o histórico mostra a objeção.',
      'Resumo para o vendedor em cada lead, no aviso de lead quente e no cartão do Kanban: dor, orçamento, prazo, quem decide e próximo passo.',
      'Dados da empresa pelo CNPJ (Receita Federal): razão social, atividade, situação e cidade, sem travar nada se a consulta falhar.',
      'Follow-ups personalizados pela IA com o que o lead já disse e envio no horário em que ele mais responde, sempre dentro do seu horário comercial.',
      'Reuniões: próximos horários livres da Agenda no lead, a IA pode propor esses horários e o botão "Não compareceu" oferece novos horários a quem faltou.',
      'Intenção e tom de cada resposta (preço, reunião, sem interesse...) e entendimento de pedidos para sair escritos de outro jeito ("não quero mais receber"), que param as mensagens automáticas.',
      'Quem já usa o SDR não tem nenhuma mudança nas mensagens: os recursos novos ficam desligados até você ligar na aba Inteligência.',
    ],
  },
  {
    versao: '1.20.0',
    data: '07/11/2026',
    titulo: 'IA de qualificação e SDR com IA agora são um só: o SDR com IA',
    itens: [
      'A "IA de qualificação" do MCK Mensagens agora faz parte do SDR com IA. No MCK Mensagens, o menu passou a se chamar "SDR com IA" e abre a mesma tela do MCKBOT, com uma só configuração.',
      'Nova aba Qualificação no SDR: as perguntas e a pontuação de 0 a 100 (frio, morno ou quente) e, logo abaixo, como a IA trata quem responde às suas campanhas (interesse, sem interesse, dúvida, novas tentativas e etiquetas).',
      'Quem já usava a qualificação não precisa fazer nada: a sua configuração foi mantida e as campanhas continuam funcionando do mesmo jeito.',
      'Quem tem o MCK Mensagens continua com a qualificação das respostas das campanhas, mesmo sem o Plano Completo. Os demais recursos do SDR (captura de leads, cadências, reuniões, rodízio e relatórios) seguem no Plano Completo.',
      'Quando alguém responde a uma campanha e também é um lead do SDR, a resposta aparece no histórico do lead e ele avança no funil (por exemplo, para Qualificado).',
    ],
  },
  {
    versao: '1.19.0',
    data: '07/11/2026',
    titulo: 'SDR com IA: Kanban junto, rodízio de leads, relatórios e formulário no seu site',
    itens: [
      'O SDR e o Kanban do MCKBOT andam juntos: quando o lead muda de etapa no SDR, o contato muda no Kanban, e quando você arrasta o contato no Kanban (para Qualificado, Ganho ou Perdido, por exemplo), o lead acompanha. Dá para desligar na Configuração do SDR.',
      'Rodízio de leads: escolha quem da equipe recebe os leads e cada lead novo sem responsável vai para o próximo da lista, um de cada vez. Também dá para distribuir de uma vez os leads que ainda estão sem responsável.',
      'Nova aba Relatórios no SDR: veja, por cadência e por passo, quantas mensagens foram enviadas, quantos responderam, quantos marcaram reunião e quantos pediram para sair, e baixe tudo em planilha (CSV).',
      'Quando o lead responde o seu e-mail, o acompanhamento para sozinho e a resposta aparece no histórico do lead. Se ele pedir para ser descadastrado na resposta, ele sai da lista na hora. Respostas automáticas, como aviso de férias, não contam.',
      'Coloque o formulário do SDR no seu próprio site: copie o código pronto na Configuração do SDR e cole na sua página. Se quiser, escolha quais sites podem mostrar o formulário.',
    ],
  },
  {
    versao: '1.18.0',
    data: '07/11/2026',
    titulo: 'Novo: SDR com IA, a pré-vendas que trabalha sozinha',
    itens: [
      'Novo menu "SDR com IA" (no Plano Completo e no teste do Plano Completo): quem chama no seu WhatsApp, preenche o seu formulário ou entra pela planilha vira lead, com nome, empresa, segmento, telefone, e-mail, origem, etapa, pontuação e dono.',
      'Modo automático ligado por padrão: a IA faz as perguntas de qualificação na conversa (necessidade, porte, prazo e orçamento, que você pode mudar), dá uma nota de 0 a 100 e classifica o lead em frio, morno ou quente.',
      'Lead quente gera um aviso no seu WhatsApp de aviso e no painel. A conversa continua com a IA: ela só passa para uma pessoa quando o cliente pede.',
      'Cadências prontas por segmento: quem para de responder recebe acompanhamento educado por WhatsApp e e-mail, só em horário comercial e dentro do limite diário. Tudo para sozinho quando o lead responde, marca reunião ou pede para sair (SAIR ou PARAR).',
      'WhatsApp só para quem chamou você ou autorizou o contato; planilha sem autorização recebe só e-mail, sempre com o link de descadastro. Quem pediu para sair nunca volta a receber.',
      'A IA marca a reunião ou demonstração sozinha na sua Agenda, com confirmação e lembrete para o cliente.',
      'Painel com funil em quadros, lista com filtros e pontuação, próximas ações, histórico de cada lead e números de contatados, respostas, qualificados, reuniões e conversão. Prefere aprovar cada envio? É só desligar o modo automático.',
    ],
  },
  {
    versao: '1.17.0',
    data: '07/11/2026',
    titulo: 'MCK ERP agora faz parte do Plano Completo',
    itens: [
      'O MCK ERP (vendas, estoque, compras, financeiro, fiscal e BI) passa a ser exclusivo do Plano Completo: MCK ERP + MCKBOT + MCK Mensagens, ativo ou em período de teste.',
      'Quem tem só o MCKBOT ou só o MCK Mensagens vê no menu do ERP o aviso "O ERP faz parte do Plano Completo", com o botão para fazer o upgrade.',
      'Seus dados do ERP continuam guardados: clientes, fornecedores, produtos, pedidos e as notas fiscais emitidas podem ser baixados a qualquer momento, mesmo sem o Plano Completo.',
    ],
  },
  {
    versao: '1.16.1',
    data: '07/11/2026',
    titulo: 'Mais proteção para a sua conta',
    itens: [
      'A proteção contra tentativas repetidas de entrar na conta agora reconhece cada visitante corretamente, sem bloquear quem não tem nada a ver com o ataque.',
      'Com o plano ou o teste vencido, o MCK ERP continua aberto para consulta; para cadastrar e alterar dados é preciso renovar, como nos outros aplicativos.',
    ],
  },
  {
    versao: '1.16.0',
    data: '05/11/2026',
    titulo: 'Primeiros passos, modelos de Instruções por segmento e resumo semanal por e-mail',
    itens: [
      'Conta nova: o cartão "Primeiros passos" na Visão geral mostra o que falta (conectar o WhatsApp, preencher as Instruções da IA e testar uma conversa) e some quando tudo estiver pronto.',
      'Modelos prontos de Instruções da IA para corretora de seguros, salão e barbearia, clínicas e consultórios, lojas, restaurantes e delivery e prestadores de serviço: é só escolher o segmento e completar os campos [preencha].',
      'Resumo semanal por e-mail para o Proprietário toda segunda às 8h: conversas atendidas, respostas da IA, transferências para humano e leads qualificados. Dá para desligar no Perfil.',
      'MCK IA com limite diário de respostas conforme o plano. Ao atingir, você recebe o aviso e ela volta no dia seguinte (ou use sua própria chave).',
      'O aplicativo fica acordado e abre mais rápido, com uma tela de carregamento mais clara.',
    ],
  },
  {
    versao: '1.15.1',
    data: '05/11/2026',
    titulo: 'MCK IA: a inteligência artificial própria da MCK, sem precisar de chave',
    itens: [
      'Nova opção "MCK IA" em Configurações da IA: a IA responde seus clientes sem você criar ou colar nenhuma chave.',
      'Atendimento mais estável: a MCK IA foi feita para não deixar seus clientes sem resposta.',
      'Quem já usa a própria chave do Google Gemini ou de outro provedor continua do mesmo jeito.',
    ],
  },
  {
    versao: '1.14.0',
    data: '05/11/2026',
    titulo: 'Indique e ganhe: 1 mês grátis por empresa indicada',
    itens: [
      'Novo cartão "Indique e ganhe" no Perfil do MCKBOT e na Assinatura do MCK Mensagens, com o seu link, botão para copiar e para compartilhar no WhatsApp.',
      'Quando uma empresa indicada por você fizer o primeiro pagamento, você ganha 1 mês grátis no seu plano e recebe um aviso por WhatsApp e por e-mail.',
      'O cartão mostra quantas empresas você indicou e quantos meses já ganhou.',
      'Cupons de parceiros podem valer só no primeiro pagamento da empresa.',
      'Novas páginas no site mostrando como o MCKBOT e o MCK Mensagens ajudam corretoras de seguros, salões e barbearias, clínicas, lojas, restaurantes e prestadores de serviço.',
    ],
  },
  {
    versao: '1.13.2',
    data: '04/11/2026',
    titulo: 'Venda balcão agora aparece no menu do MCK ERP',
    itens: [
      'Novo item "Venda balcão (PDV)" no menu do MCK ERP: abre direto a tela de venda na hora.',
      'As vendas feitas no balcão aparecem na lista de Pedidos com a etiqueta "Balcão" e no novo filtro "Vendas balcão".',
      'A busca de produtos e clientes na venda balcão encontra o item mesmo digitando em letras minúsculas.',
      'A venda balcão avisa antes de finalizar quando o produto não tem estoque suficiente.',
    ],
  },
  {
    versao: '1.13.1',
    data: '04/11/2026',
    titulo: 'Alerta de falha da IA agora chega na primeira falha de cada conversa',
    itens: [
      'Alerta de falha da IA agora chega na primeira falha de cada conversa: se a IA falhar com dois clientes diferentes, você recebe um aviso para cada um.',
      'Na mesma conversa, o aviso continua chegando no máximo uma vez a cada 30 minutos.',
    ],
  },
  {
    versao: '1.13.0',
    data: '04/11/2026',
    titulo: 'IA mais estável e aviso quando ela não consegue responder',
    itens: [
      'Quando o serviço de IA fica lento ou sobrecarregado, o atendimento tenta de novo e usa automaticamente outro modelo gratuito antes de desistir.',
      'O cliente não recebe mais a mesma mensagem de falha duas vezes seguidas: na segunda vez, ele é avisado da instabilidade e pode pedir um atendente.',
      'Nova opção "Falha da IA" nos Números de aviso (Perfil › Organização), ligada por padrão: você recebe no WhatsApp e por e-mail o contato, o horário, o motivo e o link da conversa, no máximo uma vez a cada 30 minutos por conversa.',
    ],
  },
  {
    versao: '1.12.0',
    data: '04/11/2026',
    titulo: 'Número da versão e histórico de novidades',
    itens: [
      'O número da versão aparece no fim do menu e na tela de entrada. Clique nele para ver tudo o que mudou.',
      'Nova página "Novidades e histórico de versões", com as melhorias de cada atualização.',
    ],
  },
  {
    versao: '1.11.0',
    data: '04/11/2026',
    titulo: 'Avisos no seu WhatsApp: reuniões, tarefas e pedidos',
    itens: [
      'Os "Números de aviso" (Perfil › Organização) agora recebem aviso de reunião marcada, tarefa criada e pedido feito, além do pedido de atendente.',
      'Você pode cadastrar o seu WhatsApp particular para receber os avisos e escolher quais tipos quer receber.',
      'Botão "Enviar teste" e lembrete na Visão geral, no Inbox e em Canais quando nenhum número está cadastrado.',
      'Pedidos feitos pela IA no WhatsApp e vendas no balcão do MCK ERP também avisam.',
    ],
  },
  {
    versao: '1.10.0',
    data: '04/11/2026',
    titulo: 'MCK ERP: venda balcão, planilhas, relatórios e Plano Completo',
    itens: [
      'Venda balcão: venda rápida no caixa, direto no MCK ERP.',
      'Planilhas: baixe o modelo, importe e exporte clientes, fornecedores e produtos.',
      'Relatórios do dia enviados automaticamente à noite.',
      'Funcionários com acesso só às áreas do ERP que você liberar.',
      'Clientes e fornecedores em cadastros separados; contas da empresa (água, luz, internet) separadas dos fornecedores.',
      'Alertas diários por WhatsApp: contas a pagar, estoque abaixo do mínimo e produtos parados.',
      'Código de barras automático no produto, custos extras no custo da mercadoria e "Estimativa de compra".',
      'Etiqueta com lote, lote do fornecedor e validade.',
      'Menu lateral organizado por categorias: MCK ERP, MCKBOT, MCK Mensagens e Plataforma.',
      'Novo Plano Completo: MCK ERP + MCKBOT + MCK Mensagens em uma assinatura.',
    ],
  },
  {
    versao: '1.9.0',
    data: '03/11/2026',
    titulo: 'Chegou o MCK ERP',
    itens: [
      'CRM: cadastro completo do cliente pelo CNPJ, funil de vendas em quadros e histórico de cada cliente.',
      'Produtos, preços e estoque com lotes, validade, endereços e etiquetas com QR code (impressora comum ou Zebra).',
      'Entrada de mercadoria pelo XML da nota fiscal do fornecedor e inventário com contagem às cegas.',
      'Vendas: orçamento, pedido, separação conferida por QR code e faturamento.',
      'Compras: solicitação, cotação, pedido com aprovação e recebimento conferido com a nota.',
      'Produção: ficha técnica, ordens de produção, apontamento e planejamento de materiais.',
      'Financeiro: contas a receber e a pagar, Pix copia-e-cola, conciliação bancária, fluxo de caixa e resultado do mês.',
      'Fiscal: emissão de NF-e com o certificado digital da sua empresa.',
      'Painel de indicadores com vendas, margem, estoque, compras, produção e financeiro.',
    ],
  },
  {
    versao: '1.8.0',
    data: '03/11/2026',
    titulo: 'Fluxos mais fáceis, IA mais confiável e site renovado',
    itens: [
      'Editor de fluxos: cada opção do menu liga no lugar certo, o bloco Início fica sempre acessível e há atalho para ir a qualquer bloco.',
      'IA mais confiável: não fica mais travada em "Consultando…" e tenta de novo quando não consegue responder.',
      'A IA só passa a conversa para um atendente quando o cliente pede.',
      'Aviso na hora, nos seus números de aviso, quando um cliente pede atendente.',
      'A IA pode usar as informações do site e os preços atuais, e pode organizar o Kanban sozinha (opcional).',
      'Site da empresa renovado e mais fácil de encontrar no Google.',
      'Aviso discreto de novidades no app e no site.',
    ],
  },
  {
    versao: '1.7.0',
    data: '03/11/2026',
    titulo: 'Equipe, avisos e segurança da assinatura',
    itens: [
      'Convite da equipe enviado por e-mail, com opção de reenviar.',
      'Permissões por pessoa da equipe: escolha quais módulos e quais WhatsApps cada um vê.',
      'Aviso por e-mail 5 dias antes do teste ou do plano vencer.',
      'Alerta quando o WhatsApp fica desconectado por mais de 5 minutos, no app e por e-mail.',
      'Janela central para renovar quando a assinatura vence.',
      'Catálogo de produtos usado pela IA nas respostas.',
      'Cadastro aceita o novo CNPJ com letras e números.',
      'Cópia de segurança diária dos dados enviada por e-mail.',
    ],
  },
  {
    versao: '1.6.0',
    data: '02/11/2026',
    titulo: 'Pedidos pelo WhatsApp e cadastro mais seguro',
    itens: [
      'Agenda: escolha se a IA marca reunião, anota pedido ou os dois.',
      'Pedidos com etapas, pagamento, histórico, edição e cancelamento, com aviso ao cliente pelo WhatsApp.',
      'Cadastro com código de confirmação por e-mail, CPF/CNPJ e celular.',
      'Entrada com e-mail, CPF/CNPJ ou celular.',
      'Contatos importados por planilha já ficam com o consentimento registrado.',
      'Prévia bonita quando o link do site é compartilhado.',
    ],
  },
  {
    versao: '1.5.0',
    data: '01/11/2026',
    titulo: 'Atendimento com aviso ao dono e contatos unificados',
    itens: [
      'Status "Aguardando atendente", com etapa no Kanban e aviso na tela.',
      'Importação de contatos por planilha com prévia antes de salvar.',
      'Excluir contatos um por um ou em massa no MCK Mensagens.',
      'Reuniões com link do Google Meet automático e aviso ao dono por WhatsApp.',
      'Nome em cada WhatsApp conectado (ex.: "WhatsApp 1 · Carla").',
      'Anotação para a IA em cada contato.',
      'A IA responde em todos os WhatsApps conectados.',
      'Contatos do MCKBOT aparecem no MCK Mensagens; cada cliente pode ter até 4 números.',
      'E-mails do sistema mais confiáveis.',
    ],
  },
  {
    versao: '1.4.0',
    data: '30/10/2026',
    titulo: 'Agenda, conexão por código e escudo de segurança',
    itens: [
      'Agenda de reuniões e tarefas; a IA marca horários pelo WhatsApp sem conflito.',
      'Link "Adicionar à agenda" para Google, iPhone e Outlook.',
      'Conectar o WhatsApp com o número de telefone (código de 8 dígitos), além do QR code.',
      'Escolha por WhatsApp quem responde: só fluxos, só IA ou os dois.',
      'Opção de não responder contatos salvos na agenda do celular.',
      'Verificação em duas etapas, aviso de entrada em aparelho novo e lista de sessões ativas.',
      'Conexão do WhatsApp mais estável (fim do "Aguardando mensagem").',
    ],
  },
  {
    versao: '1.3.0',
    data: '29/10/2026',
    titulo: 'Tutoriais em vídeo, cupons e site da empresa',
    itens: [
      'Tutoriais em vídeo narrados do MCKBOT e do MCK Mensagens.',
      'Cupom de desconto na hora de assinar.',
      'Site oficial da MCK Desenvolvimento, com Política de Privacidade e Termos de Uso.',
      'Mais proteção contra acessos indevidos.',
    ],
  },
  {
    versao: '1.2.0',
    data: '28/10/2026',
    titulo: 'Automações, cobranças e IA de qualificação',
    itens: [
      'Automações: lembretes, agendamentos e mensagens de marketing programadas.',
      'Cobranças com boletos, faturas, comprovantes e pagamentos.',
      'Ações em massa nos contatos: campanha, etiquetas, status e exclusão.',
      'A IA informa preços e tira dúvidas com base nas suas instruções.',
      'Fluxos e IA trabalhando juntos: o que sai do menu vai para a IA.',
      'IA de qualificação de leads no MCK Mensagens, com mensagem e próximos passos configuráveis.',
    ],
  },
  {
    versao: '1.1.0',
    data: '26/10/2026',
    titulo: 'MCK Mensagens, assinatura e app instalável',
    itens: [
      'Novo MCK Mensagens: contatos, campanhas e disparos com consentimento, horário e limite diário.',
      'Plano e assinatura com pagamento pelo Mercado Pago.',
      'App instalável no celular e no computador.',
      'Recuperação de senha por e-mail.',
      'Nova identidade visual em preto e vermelho.',
      'Comando "Voltar ao menu" nos fluxos.',
      'Página de tutoriais no menu.',
    ],
  },
  {
    versao: '1.0.0',
    data: '25/10/2026',
    titulo: 'Lançamento do MCKBOT',
    itens: [
      'Atendimento automático no WhatsApp com fluxos e inteligência artificial.',
      'Conexão do WhatsApp por QR code.',
      'Inbox, contatos e Kanban de atendimento.',
    ],
  },
];

/** Versão atual do app (a entrada mais recente do histórico). */
export const APP_VERSION = CHANGELOG[0].versao;

/** dd/mm/aaaa no fuso de Brasília. */
export function dataBr(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

export function rotuloVersao(versao: string, commit: string, data: string | null): string {
  const curto = /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 7) : commit;
  return ['Versão ' + versao, curto, data].filter(Boolean).join(' · ');
}

