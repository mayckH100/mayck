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

