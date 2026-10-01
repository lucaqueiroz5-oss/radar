# Radar

Portal de notícias pessoal que se atualiza sozinho **a cada hora**: São Paulo FC, Pittsburgh Steelers, esporte, política, economia e varejo alimentar.

Roda grátis no GitHub: o **GitHub Actions** gera a página toda hora e o **GitHub Pages** publica.

## Como colocar no ar (uns 5 minutos)

1. Crie um repositório novo no GitHub (pode ser privado se sua conta permitir Pages em repo privado; senão, público) e suba esta pasta inteira.
2. Em **Settings → Pages**, em *Build and deployment*, escolha **Deploy from a branch**, branch `main`, pasta `/docs`. Salve.
3. Em **Settings → Actions → General → Workflow permissions**, marque **Read and write permissions**. Salve.
4. Vá em **Actions → Radar → Run workflow** para gerar a primeira edição na hora.
5. Seu portal fica em `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

Depois disso ele roda sozinho a cada hora (minuto 7). O GitHub às vezes atrasa execuções agendadas em alguns minutos.

## Ajustar fontes

Tudo fica em `config/fontes.json`. Cada linha é uma fonte:

- `gn`: busca no Google News (aceita `site:`, aspas e `OR`). Ex.: `"Steelers site:post-gazette.com"`.
- `rss`: endereço de um feed direto.
- `secao`: `spfc`, `steelers`, `esporte`, `politica`, `economia` ou `varejo`.
- `peso`: 1 a 3, sobe a fonte no ranking.
- `setorista`: `true` marca como repórter especializado e dá um bônus no ranking.
- `lang`: `pt` ou `en`.

Salvou e deu push? O workflow roda de novo automaticamente.

## Testar no seu computador

```bash
npm test        # usa feeds de exemplo, sem internet
npm run gerar   # busca as fontes reais e gera docs/index.html
```

Requer Node 20 ou superior. Não tem dependências.

## Arquivos

- `scripts/gerar.mjs`: busca, ranqueia e monta a página.
- `config/fontes.json`: lista de fontes e setoristas.
- `.github/workflows/radar.yml`: agendamento de hora em hora.
- `docs/`: página publicada (`index.html`) e os dados (`noticias.json`).
