# Oportuniza

O produto certo, do fornecedor certo, na hora de vender.

Ferramenta pessoal para achar e validar produtos, comparar fornecedores, calcular margem com a tarifa e o frete reais do Mercado Livre e acompanhar a saúde da loja.

**Abrir:** https://andrecosolin.github.io/Oportuniza/ (entra com o e-mail do dono, por link de acesso, sem senha)

## O que tem

| Aba | Para que serve |
|---|---|
| Pesquisar | Produtos do catálogo do ML, quantos vendedores disputam, faixa de preço, Full e Premium |
| Nichos | **Em alta agora**: as 50 buscas em alta do ML (tendencias.mercadolivre.com.br) cruzadas com os mais vendidos, concorrência e GoBoox, em grupos (Explodindo, Cedo, Confirmado, Procura alta, Não vender) e com nota prática; foto diária às 6h20 com histórico. Abaixo, o ranking de categorias (avançado) |
| Produto | Todos os vendedores de um produto, reputação, histórico de preço e simulador de margem |
| Produtos | Produtos candidatos com etapas, perfil (perene, sazonal, tendência), vários fornecedores, nota de 0 a 100 e recomendação |
| Fornecedores | GoBoox, Quem Fornece, locais e atacadistas, com ficha, distância até Araraquara e situação |
| Saúde | Cada anúncio com visitas, conversão, margem, preço mínimo e ideal, ação recomendada, atendimento e oportunidades |
| Agente | Confere fornecedores com os anúncios do ML: pausa o que zerou, reativa o que voltou, avisa de preço no prejuízo e de produtos novos |
| Financeiro | Margem antes de vender, resultado do período, custos fixos, lucro líquido e ponto de equilíbrio |
| Minha conta | Anúncios, reputação, pedidos, chave da extensão e novo vínculo com o ML |

## Estrutura

```
docs/                 página publicada no GitHub Pages (gerada)
src/app.html          código da página (o mesmo arquivo roda como artifact no claude.ai)
tools/build.py        gera docs/index.html a partir de src/app.html
extension/            extensão do Chrome (Mercado Livre, Shopee, Google Trends, Quem Fornece e varredura da GoBoox)
supabase/functions/   Edge Functions: app (porta da página), ml, fin, saude, sup, pub (publicar no ML e agente de estoque)
supabase/migrations/  estrutura do banco (schema radar) e funções
tools/bookmarklet-goboox.js  botão de favoritos que importa custos da GoBoox
```

## Como funciona

- **Página:** HTML único, sem build. No navegador comum, entra pelo Supabase Auth (link no e-mail). Só o e-mail cadastrado em `radar.config.owner_email` acessa.
- **Leituras e gravações rápidas:** RPC `public.op_call(fn, a)`, que confere o dono e chama as funções do schema `radar`.
- **Mercado Livre, financeiro e avaliações:** Edge Function `app`, que confere o dono e repassa para `ml`, `fin` e `saude` com a chave interna.
- **Extensão:** lê as páginas do ML e do Quem Fornece e envia para a função `sup`. A chave fica no próprio Chrome (copie em Minha conta > Acessos).
- **Anúncio do concorrente:** o painel mostra desde quando ele está no ar (data da avaliação mais antiga, porque o ML não publica a data de criação), avaliações do último mês e reclamações (1 a 3 estrelas). O botão **Criar anúncio melhor** monta um rascunho em Produtos: títulos sugeridos, palavras-chave, ficha técnica, reclamações dos compradores, checklist e descrição base. Fotos e texto do concorrente não são copiados.
- **Fora do ML:** a extensão lê a busca da Shopee (vendidos, preço) e o Google Trends (subindo, estável, caindo, sazonal com meses de pico, moda passageira). Isso soma na nota de demanda do produto e preenche o perfil sazonal sozinho. O card do produto tem atalhos para abrir os dois no termo certo.
- **Publicar no ML:** no rascunho, "Publicar no Mercado Livre" abre a categoria, os campos obrigatórios da ficha, preço, estoque, tipo de anúncio, garantia, as suas fotos e a descrição. "Conferir com o ML" valida sem publicar e mostra a tarifa; "Publicar" pede dois toques e, por padrão, cria o anúncio pausado.

Nenhuma chave fica no repositório: todas são geradas no banco e lidas depois do login.

## Publicar

1. Edite `src/app.html` e rode `python3 tools/build.py`.
2. Commit e push na `main`: o GitHub Pages publica a pasta `docs/`.

## Instalar a extensão

1. Baixe a pasta `extension/` (ou o zip da release).
2. No Chrome: `chrome://extensions`, ligue o Modo do desenvolvedor e use Carregar sem compactação.
3. Clique no ícone, cole a chave de Minha conta > Acessos e salve.
