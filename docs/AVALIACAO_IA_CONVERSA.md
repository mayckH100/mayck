# Avaliação da IA conversacional avançada (v1.26.0)

Gerado por `npx tsx scripts/avaliar-conversa.ts` a partir de `tests/fixtures/conversas-avaliacao.ts` (conferido por `tests/unit/sdr-conversa-avaliacao.test.ts`).

**Como ler:** são conversas de teste com nomes e números fictícios. "Antes" é a resposta típica do jeito antigo, enviada como veio. "Depois" é a saída do modelo com o prompt novo passando pelo caminho novo do código (plano interno, estilo, checagem final, 1 nova tentativa, especialista e handoff). As respostas do modelo são fixas: o relatório mede as regras e a rede de segurança do código, não a qualidade de um modelo real. Avaliar com conversas reais (MCK IA) fica para depois do deploy.

**Conversas que passam em todos os critérios:** antes 1/10 (10%) · depois 10/10 (100%)

| Critério | Antes | Depois |
|---|---|---|
| Curta (até 500 caracteres) | 10/10 (100%) | 10/10 (100%) |
| No máximo uma pergunta | 6/10 (60%) | 10/10 (100%) |
| Sem frase de robô | 4/10 (40%) | 10/10 (100%) |
| Emoji só se a empresa usa | 8/10 (80%) | 10/10 (100%) |
| Não pergunta o que já foi respondido | 8/10 (80%) | 10/10 (100%) |
| Fiel às Instruções (sem valor inventado, dado sensível ou provedor) | 7/10 (70%) | 10/10 (100%) |
| Nada interno vaza ([PLANO]) | 10/10 (100%) | 10/10 (100%) |
| Passa ao vendedor quando deve (e só então) | 7/10 (70%) | 10/10 (100%) |

## Conversas

### saudacao-robotica — Lead responde "oi" à campanha
- Lead: "oi, quem é?"
- Antes: "Olá! Entendido perfeitamente! 😊 Fico feliz em ajudar. Sou o assistente virtual da Corretora Exemplo e estou à disposição para qualquer dúvida que você tiver. Você tem interesse em seguro? Qual o porte da sua empresa? Quantos funcionários?" — falhou em: umaPergunta, semRobo, emojiCerto
- Depois: "Oi, Paula! Aqui é da Corretora Exemplo, te mandei a mensagem sobre seguro empresarial. Vocês já têm algum seguro hoje?" — falhou em: nada

### nao-reperguntar — Lead já disse o número de funcionários
- Lead: "e quanto fica?"
- Antes: "Ótima pergunta, Marcos! O valor depende do porte. Quantos funcionários vocês têm, Marcos?" — falhou em: semRobo, naoRepergunta
- Depois: "Para 12 funcionários começa em R$ 89,90 por mês. Vocês preferem pagar mensal ou anual?" — falhou em: nada

### preco-inventado — Modelo inventa um preço; a checagem pede nova tentativa
- Lead: "tem plano mais barato?"
- Antes: "Temos sim! O Plano Lite sai por R$ 29,90/mês." — falhou em: fiel
- Depois (após 1 nova tentativa): "O mais em conta é o Essencial, R$ 49,90/mês, e dá para testar 7 dias grátis. Quer que eu libere o teste?" — falhou em: nada

### cobertura-fora — Pergunta fora das Instruções; modelo insiste em inventar
- Lead: "cobre enchente? quanto a mais?"
- Antes: "Cobre sim! A cobertura de enchente custa R$ 15 a mais por mês e o prazo de carência é de 30 dias." — falhou em: fiel, handoffCerto
- Depois (passou ao vendedor) (após 1 nova tentativa): "Essa informação eu prefiro confirmar com o especialista para não te passar nada errado. Já te retorno por aqui." — falhou em: nada

### irritado — Lead irritado com perguntas repetidas
- Lead: "já falei isso, vocês não entendem nada"
- Antes: "Peço desculpas pelo transtorno! Entendido perfeitamente. Poderia me informar novamente o porte da sua empresa?" — falhou em: semRobo, naoRepergunta, handoffCerto
- Depois (passou ao vendedor): "Desculpa, você tem razão. Vou chamar um especialista da equipe para continuar com você por aqui." — falhou em: nada

### pedido-humano — Lead pede para falar com uma pessoa
- Lead: "quero falar com um atendente"
- Antes (passou ao vendedor): "Claro! Vou transferir você." — falhou em: nada
- Depois (passou ao vendedor): "Claro, já chamo alguém da equipe para continuar com você." — falhou em: nada

### lead-quente — Lead quer contratar
- Lead: "gostei, quero contratar o Pro"
- Antes: "Que ótimo!!! 🎉🎉 Fico feliz em ajudar! O Plano Pro é excelente e tem muitos recursos. Posso te ajudar com mais alguma coisa? Quer saber mais sobre as funcionalidades?" — falhou em: umaPergunta, semRobo, handoffCerto
- Depois (passou ao vendedor): "Show! 🙂 O Pro é R$ 99,90/mês. Um especialista da equipe já te chama para finalizar." — falhou em: nada

### objecao-caro — Objeção de preço, tom informal
- Lead: "achei caro kkk"
- Antes: "Entendo perfeitamente sua preocupação com o valor! Nosso seguro oferece uma excelente relação custo-benefício, com coberturas completas e atendimento de qualidade. Além disso, temos condições especiais que podem se adequar ao seu orçamento. Gostaria de saber mais? Posso te enviar uma proposta personalizada? Qual seria o valor ideal para você?" — falhou em: umaPergunta, semRobo
- Depois: "No anual sai com 10% de desconto, ajuda bastante. Quer que eu simule pra você?" — falhou em: nada

### provedor — Lead pergunta se é robô; modelo cita a tecnologia
- Lead: "você é um robô?"
- Antes: "Sou uma assistente virtual baseada no Gemini do Google, treinada para te ajudar!" — falhou em: fiel
- Depois (após 1 nova tentativa): "Sou a assistente virtual da equipe e posso te ajudar com a agenda da clínica. Vocês atendem quantos pacientes por dia?" — falhou em: nada

### modelo-ignora-estilo — Modelo ignora as regras de estilo (rede de segurança local)
- Lead: "como funciona o teste?"
- Antes: "Ótima pergunta, Íris! 😊 O teste grátis dura 7 dias. Quer começar hoje? Posso criar sua conta? Qual seu e-mail?" — falhou em: umaPergunta, semRobo, emojiCerto
- Depois: "O teste grátis dura 7 dias. Quer começar hoje?" — falhou em: nada

