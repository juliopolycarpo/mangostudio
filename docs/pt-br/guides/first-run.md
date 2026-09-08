# Primeira execução

Tudo abaixo é opcional. O MangoStudio funciona se você pular tudo — o fluxo de
configuração existe para que ninguém precise *adivinhar* o que configurar
primeiro, não para trancar a aplicação atrás de um formulário.

> 🇺🇸 [Read in English](../../guides/first-run.md)

## Do binário instalado até o navegador

```bash
mangostudio setup
```

Um comando leva uma instalação nova até um hub funcionando:

1. gera e guarda um `BETTER_AUTH_SECRET` se nenhum estiver configurado;
2. pergunta se deve instalar o serviço em segundo plano (veja abaixo);
3. inicia o hub, ou reaproveita um que já esteja rodando;
4. abre no navegador e imprime o endereço.

Um hub que já está servindo nunca é reiniciado. Um arquivo de estado deixado por
um que travou é limpo e substituído.

**Em uma máquina sem display** — por SSH, em um contêiner, em um servidor sem
interface — nada finge abrir um navegador. O endereço é impresso junto com uma
linha de encaminhamento de porta:

```
MangoStudio is running at http://localhost:3001
No browser can be opened from here. Open that address on this machine, or
forward the port: ssh -L 3001:localhost:3001 <this-host>
```

**Em um script**, `--service` ou `--no-service` é obrigatório. Instalar uma
unidade de serviço é uma mudança na máquina que sobrevive ao comando, então sem
ninguém no teclado a resposta é recusada em vez de presumida em qualquer
direção:

```bash
mangostudio setup --no-service --no-open
```

`--no-open` imprime a URL em vez de abrir qualquer coisa.

## O fluxo de configuração no navegador

Na primeira vez que você entra, o MangoStudio abre a **Configuração** em vez da
página de chat. São seis passos, todos puláveis, e nenhum deles é a única forma
de fazer o que faz.

| Passo             | O que pergunta                                                        |
| ----------------- | --------------------------------------------------------------------- |
| **Boas-vindas**   | Nada. Diz onde as coisas rodam e o que você está escolhendo.          |
| **Pasta**         | Qual projeto o agente lê e edita.                                     |
| **Toolchain**     | Se há Node ou Bun na máquina, e instala um se não houver.             |
| **Agentes**       | Quem responde: um modelo com a sua chave, ou uma CLI de agente local. |
| **Sempre ativo**  | Se o hub deve sobreviver a logout e reinicialização.                  |
| **Primeiro chat** | Uma pergunta de verdade, na pasta que você escolheu.                  |

O progresso pertence à sua conta, não ao navegador: fechar a aba e voltar
retoma de onde você estava, em qualquer dispositivo.

### O que "retomar" significa de verdade

O fluxo não lembra em que passo você estava. Ele lê o que a máquina diz *agora*
e abre na primeira pergunta ainda sem resposta. Então:

- apague a pasta escolhida, e ele reabre em **Pasta**;
- desconecte uma CLI de agente, e ele reabre em **Agentes**;
- instale o Node por fora, e o **Toolchain** simplesmente fica pronto.

Uma requisição que ainda não respondeu aparece como *Verificando*, nunca como
*não feito* — uma rede lenta não pode arrastar você de volta por passos que já
terminou.

### Pular

**Pular por enquanto** marca um passo como pulado e segue adiante. **Pular a
configuração** registra o fluxo inteiro como concluído e leva você para a página
que estava pedindo. Nenhum dos dois envia mensagem nem cria chat.

Para refazer: **Configurações → Geral → Refazer a configuração**. Isso limpa o
registro de progresso e mais nada — seus chats, seus logins de fornecedores e
suas configurações de máquina continuam exatamente como estão.

## Passos que não podem ser feitos de onde você está

Dois passos dependem de *onde o navegador está*, não da conta:

- **Sempre ativo** instala uma unidade de serviço para o processo do próprio
  hub. Se você abriu o MangoStudio de outro computador — ou a plataforma não tem
  gerenciador de serviços por usuário — o passo diz isso e entrega o comando
  para rodar lá.
- **Agentes** oferece as CLIs de agente instaladas na máquina escolhida. Elas
  entram com a conta do próprio fornecedor, em um terminal daquela máquina; o
  MangoStudio nunca vê essas credenciais e nunca as pede.

## Uma segunda pessoa no mesmo hub

Os logins de CLIs de agente na máquina Local pertencem à conta de sistema
operacional em que o hub roda. Assim que existe uma segunda conta MangoStudio no
mesmo hub, esses logins deixam de ser oferecidos — eles não são da segunda
pessoa, e o MangoStudio não vai fingir que são compartilhando uma conta de
fornecedor entre dois usuários.

As opções da segunda pessoa são usar uma chave de provider de modelo, ou
adicionar uma máquina própria em **Ambientes**, o que lhe dá logins de agente
isolados. O fluxo diz isso no passo **Agentes** em vez de mostrar um runner que
todo envio recusaria.

## O primeiro chat

O último passo cria um chat na pasta escolhida, apontado para o runner
escolhido, e envia a mensagem da caixa. É sempre um clique explícito — nada é
enviado só por chegar no passo.

Duas coisas que ele deliberadamente não faz:

- **Criar um segundo chat.** A referência do chat é salva no instante em que a
  criação retorna, antes de qualquer envio. Recarregar no meio reabre aquele
  chat.
- **Enviar o mesmo prompt duas vezes.** Antes de enviar, ele relê a transcrição;
  um prompt que já está lá significa que o envio foi aceito e só a resposta se
  perdeu, então ele espera em vez de perguntar de novo.

Um chat existir não é prova de que algo respondeu. O passo só fica pronto quando
a transcrição realmente carrega uma resposta — ou quando você o pula.

Se o runner for uma CLI de agente que você ainda não usou, o aviso de terceiros
aparece aqui, e a pergunta de confiança no workspace aparece na primeira vez que
um fornecedor é apontado para uma pasta. São os mesmos diálogos que o compositor
levanta, respondidos uma vez.
